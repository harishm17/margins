import { readSession } from '@/lib/auth/get-session'
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await readSession();
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

    // Fetch all exams for this project
    const exams = await prisma.sampleExam.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        difficultyLevel: true,
        topicsCovered: true,
        createdAt: true,
        _count: {
          // Attempts still in progress are not attempts yet.
          select: { submissions: { where: { status: 'submitted' } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // The user's latest submission for every exam, in one query. The score is read in SQL so
    // the grading JSON (every question and answer) is not loaded just to show a percentage.
    const examIds = exams.map((exam) => exam.id);
    const latestRows =
      examIds.length === 0
        ? []
        : await prisma.$queryRaw<
            Array<{ sampleExamId: string; submittedAt: Date; overallScore: number | null }>
          >(Prisma.sql`
            SELECT DISTINCT ON (sample_exam_id)
              sample_exam_id AS "sampleExamId",
              submitted_at AS "submittedAt",
              CASE WHEN jsonb_typeof(ai_grading -> 'overall_score') = 'number'
                THEN (ai_grading ->> 'overall_score')::float8 END AS "overallScore"
            FROM exam_submissions
            WHERE user_id = ${session.user.id}
              AND status = 'submitted'
              AND sample_exam_id IN (${Prisma.join(examIds)})
            ORDER BY sample_exam_id, submitted_at DESC
          `);
    const latestByExam = new Map(latestRows.map((row) => [row.sampleExamId, row]));

    const examsWithScores = exams.map((exam) => {
      const latest = latestByExam.get(exam.id);
      return {
        ...exam,
        attemptsCount: exam._count.submissions,
        lastAttempt: latest?.submittedAt,
        lastScore: latest?.overallScore ?? null,
      };
    });

    return NextResponse.json({ exams: examsWithScores });
  } catch (error) {
    console.error('Error fetching exams:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
