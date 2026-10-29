import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { z } from 'zod';
import { stableStringify } from '@/lib/utils/stable-json';
import {
  apiError,
  ApiErrorCode,
  apiInternal,
  apiUnauthorized,
  apiUpstream,
  zodDetails,
} from '@/lib/api/errors';
import { ensureAiGenerationReady } from '@/lib/api/ai-preflight';


const generateExamSchema = z.object({
  topicIds: z.array(z.string()).min(1, 'At least one topic must be selected'),
  totalQuestions: z.number().min(5).max(100),
  durationMinutes: z.number().min(15).max(300),
  difficultyLevel: z.enum(['easy', 'medium', 'hard']),
  // Write the questions in the style of the course's past exams (their merged style profile).
  matchPastExams: z.boolean().optional(),
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

    const body = await req.json();
    const validation = generateExamSchema.safeParse(body);

    if (!validation.success) {
      return apiError(
        ApiErrorCode.INVALID_INPUT,
        'Invalid input',
        zodDetails(validation.error),
        400
      );
    }

    const uniqueTopicIds = Array.from(new Set(validation.data.topicIds));
    const { totalQuestions, durationMinutes, difficultyLevel, questionTypeDistribution, matchPastExams } = validation.data;

    // Verify all topics belong to this project
    const topics = await prisma.topic.findMany({
      where: {
        id: { in: uniqueTopicIds },
        projectId,
      },
      select: { id: true },
    });

    if (topics.length !== uniqueTopicIds.length) {
      return NextResponse.json(
        { error: 'Some topics not found or do not belong to this project' },
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
    const job = await prisma.processingJob.create({
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

    // Enqueue task via Cloud Tasks (or direct call in dev)
    try {
      const { enqueueTask } = await import('@/lib/tasks/cloud-tasks');
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
    console.error('Error in generate-exam:', error);
    return apiInternal('Internal server error');
  }
}
