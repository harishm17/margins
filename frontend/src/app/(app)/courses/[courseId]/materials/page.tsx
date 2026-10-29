import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Page } from '@/components/shell/page'
import { ExtractionBanner } from '@/features/course/extraction'
import { MaterialsManager } from '@/features/course/materials-manager'
import { getCourseShell } from '@/server/queries/courses'
import { getMaterialsData } from '@/server/queries/course'
import { requireUser } from '@/server/session'

export const metadata: Metadata = { title: 'Materials' }

export default async function MaterialsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requireUser()
  const { courseId } = await params
  const course = await getCourseShell(user.id, courseId)
  if (!course) notFound()
  const data = await getMaterialsData(user.id, courseId)

  return (
    <Page>
      <MaterialsManager
        courseId={courseId}
        maxUploadMb={data.maxUploadMb}
        materials={data.materials}
        typicalReadSeconds={data.typicalReadSeconds}
        banner={
          <ExtractionBanner
            courseId={courseId}
            extractJob={data.extractJob}
            extractFailure={data.extractFailure}
            setup={course.setup}
            filesReady={data.readyCount > 0 && data.processingCount === 0}
            reading={data.readyCount > 0 && data.processingCount > 0}
          />
        }
      />
    </Page>
  )
}
