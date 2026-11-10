import { viewerUrl } from '@/lib/chat/citations'
import { prisma } from '@/lib/db/prisma'
import { pageLabel } from './page-refs'

export type PageLink = { label: string; href: string }

type ClaimPages = { pageStart: number | null; pageEnd: number | null; materialId: string; material: { filename: string } }

/**
 * A link to each place in the student's own file that claims point to, from the claims' structured pages (pageStart and
 * pageEnd), not from any text. A claim with no page has no link; the same place is listed once.
 */
export function pageLinksOf(claims: ClaimPages[]): PageLink[] {
  const links: PageLink[] = []
  for (const claim of claims) {
    if (!claim.pageStart) continue
    const link = {
      label: pageLabel(claim.pageStart, claim.pageEnd),
      href: viewerUrl({ materialId: claim.materialId, filename: claim.material.filename, pageStart: claim.pageStart }),
    }
    if (!links.some((seen) => seen.label === link.label && seen.href === link.href)) links.push(link)
  }
  return links
}

/** The page links of the claims of some concepts of a course (a question's concepts, for the oral quiz's list of what to revisit), at most `limit`. */
export async function conceptPageLinks(projectId: string, conceptIds: string[], limit = 3): Promise<PageLink[]> {
  if (conceptIds.length === 0) return []
  const claims = await prisma.conceptClaim.findMany({
    where: { conceptId: { in: conceptIds }, concept: { projectId } },
    orderBy: { orderIndex: 'asc' },
    select: { conceptId: true, pageStart: true, pageEnd: true, materialId: true, material: { select: { filename: true } } },
  })
  // In the order the question names its concepts: ids are random, so an order by id would differ from one course to the next.
  const place = (conceptId: string) => conceptIds.indexOf(conceptId)
  return pageLinksOf(claims.sort((a, b) => place(a.conceptId) - place(b.conceptId))).slice(0, limit)
}
