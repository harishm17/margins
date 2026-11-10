import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

const getOverallScore = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as { overall_score?: unknown }).overall_score;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
};

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ examId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { examId } = await params;

    // Verify exam exists and user has access
    const exam = await prisma.sampleExam.findFirst({
      where: {
        id: examId,
        project: {
          userId: session.user.id,
        },
      },
      select: { id: true },
    });

    if (!exam) {
      return NextResponse.json({ error: 'Exam not found' }, { status: 404 });
    }

    // Fetch user's submissions for this exam
    const submissions = await prisma.examSubmission.findMany({
      where: {
        sampleExamId: examId,
        userId: session.user.id,
        // An attempt still in progress is not a submission yet.
        status: 'submitted',
      },
      select: {
        id: true,
        submittedAt: true,
        gradedAt: true,
        aiGrading: true,
      },
      orderBy: { submittedAt: 'desc' },
    });

    // Calculate stats
    const gradedSubmissions = submissions.filter((s) => s.aiGrading);
    let stats = null;

    if (gradedSubmissions.length > 0) {
      const scores = gradedSubmissions.map(
        (s) => getOverallScore(s.aiGrading) ?? 0
      );

      stats = {
        bestScore: Math.max(...scores),
        latestScore: scores[0] || 0,
        averageScore: scores.reduce((a, b) => a + b, 0) / scores.length,
        totalAttempts: submissions.length,
      };
    }

    return NextResponse.json({
      submissions: submissions.map((s) => ({
        id: s.id,
        submittedAt: s.submittedAt,
        gradedAt: s.gradedAt,
        score: getOverallScore(s.aiGrading),
        isPending: !s.aiGrading,
      })),
      stats,
    });
  } catch (error) {
    logServerError('Error fetching submissions', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
