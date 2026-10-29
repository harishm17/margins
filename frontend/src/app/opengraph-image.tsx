import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { BrandIcon } from '@/components/shell/brand-icon'
import { BRAND_NAME } from '@/config/brand'
import { BRAND_COLORS } from '@/config/site'

export const alt = `${BRAND_NAME}: study from your own course files`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** The social card: brand, headline, and a product screenshot (the plan's main column). Built once at build time. */
export default async function OpengraphImage() {
  const [font, screenshot] = await Promise.all([
    readFile(path.join(process.cwd(), 'node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf')),
    readFile(path.join(process.cwd(), 'public/screens/plan-og.png')),
  ])
  const screenshotUrl = `data:image/png;base64,${screenshot.toString('base64')}`
  // Drawn whole, at the width the right column leaves (1200 - 560 - 24 left and right), at the picture's own
  // proportions: a PNG's width and height are in its header. npm run screens writes the picture (plan-og.png).
  const shotWidth = 592
  const shotHeight = Math.round((shotWidth * screenshot.readUInt32BE(20)) / screenshot.readUInt32BE(16))

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: BRAND_COLORS.canvas,
          fontFamily: 'Geist',
          color: '#171b20',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: 560, padding: 64 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <BrandIcon size={44} radius={13} />
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.4 }}>{BRAND_NAME}</div>
          </div>
          <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.06, letterSpacing: -1.6 }}>
            Study from your own course files.
          </div>
        </div>
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', paddingLeft: 24, paddingRight: 24 }}>
          <img
            src={screenshotUrl}
            alt=""
            width={shotWidth}
            height={shotHeight}
            style={{
              borderRadius: 16,
              border: '1px solid #e1e3e5',
            }}
          />
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: 'Geist', data: font, weight: 600, style: 'normal' }] }
  )
}
