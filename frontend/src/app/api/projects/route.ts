import { readSession } from '@/lib/auth/get-session'
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { z } from 'zod';
import { dailyMinutesSchema, examDateColumn, examDateSchema } from '@/lib/learning/plan-settings';

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  // Optional: the exam date (YYYY-MM-DD) and minutes the student can study each day.
  examDate: examDateSchema.optional(),
  dailyMinutes: dailyMinutesSchema.optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await readSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const validation = createProjectSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error.errors },
        { status: 400 }
      );
    }

    const { name, description, examDate, dailyMinutes } = validation.data;

    const project = await prisma.project.create({
      data: {
        userId: session.user.id,
        name,
        description,
        status: 'setup',
        ...(examDate !== undefined ? { examDate: examDateColumn(examDate) } : {}),
        ...(dailyMinutes !== undefined ? { dailyMinutes } : {}),
      },
    });

    return NextResponse.json({ project });
  } catch (error) {
    console.error('Error creating project:', error);
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
}
