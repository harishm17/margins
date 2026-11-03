'use client'

import * as React from 'react'
import type { CheckGrade } from '@/lib/reader/checks'

/**
 * Where a "Check yourself" block sends the student's own grade (spec §5.4: Got it, Partly or Missed, level 2).
 * The markdown renderer knows nothing about topics: the screen that shows a lesson provides the handler, and a
 * block outside one (a chat answer) has none, so it asks for an answer and reveals but offers no grade.
 * The handler resolves once the grade is saved, saying whether it was counted (`recorded`), and throws when it could not be saved.
 */
export type CheckGradeHandler = (input: {
  question: string
  grade: CheckGrade
  idk: boolean
  conceptId: string | null
  /** A worked example's concepts; the grade is filed under each. */
  conceptIds?: string[]
}) => Promise<{ recorded: boolean } | void>

export const CheckGradeContext = React.createContext<CheckGradeHandler | null>(null)

/**
 * Where a "Check yourself" block keeps what the student has typed (spec §18.7, surface explainer_check): the project and
 * topic the draft belongs to, and `scope`, which names the part of the page the block sits in so two blocks never share a
 * draft. The explainer views provide it; a block outside one (a chat answer) has none and keeps its text in the page only.
 */
export type ExplainerDraftScope = { projectId: string | null; topicId: string; scope: string }

export const ExplainerDraftContext = React.createContext<ExplainerDraftScope | null>(null)
