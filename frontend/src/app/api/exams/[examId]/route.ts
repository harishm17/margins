import { logServerError } from '@/lib/ops/log'
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { toPublicQuestions } from '@/lib/learning/quiz-questions';

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

    // Fetch exam with project to verify ownership
    const exam = await prisma.sampleExam.findFirst({
      where: {
        id: examId,
        project: {
          userId: session.user.id,
        },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!exam) {
      return NextResponse.json({ error: 'Exam not found' }, { status: 404 });
    }

    // No answer key: it is released only in a graded submission's results.
    return NextResponse.json({ exam: { ...exam, questions: toPublicQuestions(exam.questions) } });
  } catch (error) {
    logServerError('Error fetching exam', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
