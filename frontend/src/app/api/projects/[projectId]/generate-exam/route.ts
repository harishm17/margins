import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { assertQuota, quotaErrorResponse } from '@/lib/api/quota'
import { id, list, record } from '@/lib/api/fields'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { z } from 'zod';
import { stableStringify } from '@/lib/utils/stable-json';
import {
  apiInternal,
  apiUnauthorized,
  apiUpstream,
} from '@/lib/api/errors';
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight';


const generateExamSchema = z.object({
  topicIds: list(id(), 200).min(1, 'At least one topic must be selected'),
  totalQuestions: z.number().min(5).max(100),
  durationMinutes: z.number().min(15).max(300),
  difficultyLevel: z.enum(['easy', 'medium', 'hard']),
  // Write the questions in the style of the course's past exams (their merged style profile).
  matchPastExams: z.boolean().optional(),
  // What the student calls the exam; without one it is named by its date and topics.
  name: z.string().trim().max(80).optional(),
  questionTypeDistribution: z.object({
    multiple_choice: z.number().min(0).max(100),
    short_answer: z.number().min(0).max(100),
    numerical: z.number().min(0).max(100),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.questionTypeDistribution) {
    const total =
      value.questionTypeDistribution.multiple_choice +
      value.questionTypeDistribution.short_answer +
      value.questionTypeDistribution.numerical;
    if (Math.abs(total - 100) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'questionTypeDistribution must add up to 100',
        path: ['questionTypeDistribution'],
      });
    }
  }
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const limited = await enforceMutationLimit(session.user.id);
    if (limited) return limited;

    const { projectId } = await params;

    // Verify user owns project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const preflightError = await ensureAiGenerationReady(session.user.id);
    if (preflightError) {
      return preflightError;
    }

    const validation = await readJson(req, generateExamSchema)
    if (!validation.ok) return validation.response

    const uniqueTopicIds = Array.from(new Set(validation.data.topicIds));
    const { totalQuestions, durationMinutes, difficultyLevel, questionTypeDistribution, matchPastExams, name } = validation.data;

    // Verify all topics belong to this project and are confirmed (new topics wait for review)
    const topics = await prisma.topic.findMany({
      where: {
        id: { in: uniqueTopicIds },
        projectId,
        userConfirmed: true,
      },
      select: { id: true },
    });

    if (topics.length !== uniqueTopicIds.length) {
      return NextResponse.json(
        { error: 'Some topics were not found, are not confirmed, or do not belong to this project' },
        { status: 400 }
      );
    }

    // Default question type distribution
    const defaultDistribution = {
      multiple_choice: 60,
      short_answer: 30,
      numerical: 10,
    };

    const config = {
      total_questions: totalQuestions,
      duration_minutes: durationMinutes,
      difficulty_level: difficultyLevel,
      question_type_distribution: questionTypeDistribution || defaultDistribution,
      // Only when asked for, so the idempotency key of an exam without it is what it always was.
      ...(matchPastExams ? { match_past_exams: true } : {}),
      // Only when given, for the same reason.
      ...(name ? { exam_name: name } : {}),
    };

    const idempotencyKey = `${projectId}:${uniqueTopicIds.sort().join(',')}:${stableStringify(config)}`;
    const existingJob = await prisma.processingJob.findFirst({
      where: {
        userId: session.user.id,
        projectId,
        jobType: 'generate_exam',
        status: { in: ['pending', 'processing'] },
        inputData: {
          path: ['idempotencyKey'],
          equals: idempotencyKey,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingJob) {
      return NextResponse.json({
        jobId: existingJob.id,
        status: existingJob.status === 'processing' ? 'processing' : 'queued',
        message: 'Exam generation already in progress',
        estimatedSeconds: 90,
      });
    }

    // Create processing job
    const job = await prisma.$transaction(async (tx) => {
      await assertQuota(tx, session.user, 'generationJobs');
      return tx.processingJob.create({
        data: {
          userId: session.user.id,
          projectId,
          jobType: 'generate_exam',
          status: 'pending',
          stage: 'generating',
          inputData: {
            projectId,
            topicIds: uniqueTopicIds,
            config,
            idempotencyKey,
          },
        },
      });
    });

    // Send the job to the AI service
    try {
      const { enqueueTask } = await import('@/lib/tasks/dispatch');
      await enqueueTask('/jobs/generate-exam', {
        jobId: job.id,
        jobType: 'generate_exam',
        data: {
          projectId,
          topicIds: uniqueTopicIds,
          config,
        },
      });
    } catch (error) {
      console.error('Error enqueuing job:', error);
      const retryable = typeof (error as { retryable?: unknown })?.retryable === 'boolean'
        ? Boolean((error as { retryable: boolean }).retryable)
        : true

      // Update job status to failed
      await prisma.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
          errorMessage: 'Failed to start exam generation',
          retryable,
          completedAt: new Date(),
        },
      });

      return apiUpstream('Failed to start exam generation');
    }

    return NextResponse.json({
      jobId: job.id,
      status: 'queued',
      message: 'Exam generation started',
      estimatedSeconds: 90,
    });
  } catch (error) {
    const refused = quotaErrorResponse(error);
    if (refused) return refused;
    console.error('Error in generate-exam:', error);
    return apiInternal('Internal server error');
  }
}
