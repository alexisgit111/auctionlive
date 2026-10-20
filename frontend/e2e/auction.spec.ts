import { expect, test, type Page } from '@playwright/test'

test.skip(process.env.E2E_BACKEND === 'http', 'prototype (mock) backend only')

/**
 * Phase 1A end-to-end: Staff Console and Room Display in two windows.
 * (Phase 1A shares a browser context because the mock backend lives in
 * localStorage; Phase 1C switches this to two separate browser contexts
 * against the real API.)
 */

const SHOTS = process.env.SHOTS_DIR

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** Sign in (prototype demo accounts use password demo1234). Lands on the console. */
async function signIn(page: Page, email = 'admin@demo.local', password = 'demo1234') {
  await page.goto('/auction/login?next=/auction/control')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Current accepted bid')).toBeVisible()
}

async function enterBid(page: Page, amount: string) {
  const input = page.locator('#bid-input')
  await input.fill(amount)
  await input.press('Enter') // preview → confirm
  await input.press('Enter') // confirm → commit
  await expect(input).toHaveValue('')
}

test('full auction: pair display, bid, on the market, faults, sold', async ({ context }) => {
  const consolePage = await context.newPage()
  await signIn(consolePage)
  await expect(consolePage.getByText('Current accepted bid')).toBeVisible()

  // Optional: give the demo property a photo + badge (for screenshots)
  if (process.env.DEMO_PHOTO) {
    const fs = await import('node:fs')
    const photo = 'data:image/jpeg;base64,' + fs.readFileSync(process.env.DEMO_PHOTO).toString('base64')
    const person = process.env.DEMO_PERSON ? 'data:image/jpeg;base64,' + fs.readFileSync(process.env.DEMO_PERSON).toString('base64') : null
    await consolePage.evaluate(
      ([photo, person]) => {
        const db = JSON.parse(localStorage.getItem('gl-auction-db-v1')!)
        const s = Object.values(db.sessions)[0] as Record<string, unknown> & { property: Record<string, unknown> }
        Object.assign(s.property, { heroImage: photo, badge: 'Brought Forward', addressLine: '15 Example Avenue', suburb: 'Flat Bush' })
        Object.assign(s, { salespeople: [{ name: 'Jane Smith', photo: person }, { name: 'Michael Chen', photo: null }] })
        localStorage.setItem('gl-auction-db-v1', JSON.stringify(db))
      },
      [photo, person],
    )
    await consolePage.reload()
    await expect.poll(() => consolePage.evaluate(() => localStorage.getItem('gl-auction-db-v1')!.includes('data:image'))).toBe(false)
  }

  // Take control and start
  await consolePage.getByTestId('acquire').click()
  await expect(consolePage.getByText(/You have control/)).toBeVisible()
  await consolePage.getByRole('button', { name: 'Start auction' }).click()

  // Room display pairs
  const display = await context.newPage()
  await display.setViewportSize({ width: 1600, height: 900 })
  await display.goto('/auction/pair')
  const codeEl = display.getByTestId('pair-code')
  await expect(codeEl).not.toContainText('·')
  const code = (await codeEl.innerText()).replace(/\s/g, '')
  await shot(display, '01-display-pairing')
  await consolePage.getByLabel('Pairing code').fill(code)
  await consolePage.getByRole('button', { name: 'Approve' }).click()
  await display.waitForURL(/\/auction\/display\//)
  await expect(display.getByTestId('display-status')).toHaveText(/Auction live/i)
  if (process.env.DEMO_PHOTO) await expect(display.getByTestId('display-salespeople')).toBeVisible()

  // Bids in each accepted format
  await enterBid(consolePage, '950K')
  await expect(display.getByTestId('display-bid')).toHaveText('$950,000')
  await enterBid(consolePage, '1.1M')
  await enterBid(consolePage, '1250 K')

  // Lower bid is rejected in preview, never reaches display
  await consolePage.locator('#bid-input').fill('1200K')
  await expect(consolePage.getByText(/Must be higher than current bid/)).toBeVisible()
  await consolePage.locator('#bid-input').press('Escape')

  // Quick increment F2 (+5K) → confirm
  await consolePage.locator('#bid-input').press('F2')
  await consolePage.locator('#bid-input').press('Enter')
  await expect(display.getByTestId('display-bid')).toHaveText('$1,255,000')

  await consolePage.getByRole('button', { name: 'On the market' }).click()
  await expect(display.getByTestId('display-status')).toHaveText(/On the market/i)

  // ── Stickers can be hidden, and On the market can be undone ──
  await expect(display.getByTestId('display-circle')).toBeVisible()
  await consolePage.getByTestId('toggle-overlay').click()
  await expect(display.getByTestId('display-circle')).toHaveCount(0, { timeout: 5000 })
  await consolePage.getByTestId('toggle-overlay').click()
  await expect(display.getByTestId('display-circle')).toBeVisible({ timeout: 5000 })
  await consolePage.getByRole('button', { name: 'Undo on the market', exact: true }).click()
  await expect(display.getByTestId('display-status')).not.toHaveText(/On the market/i, { timeout: 5000 })
  await consolePage.getByRole('button', { name: 'On the market', exact: true }).click()
  await expect(display.getByTestId('display-status')).toHaveText(/On the market/i, { timeout: 5000 })
  await enterBid(consolePage, '1275000')
  await expect(display.getByTestId('display-bid')).toHaveText('$1,275,000')
  await expect(consolePage.getByText('Synced')).toBeVisible({ timeout: 5000 })
  await shot(consolePage, '02-console-live')
  await shot(display, '03-display-on-the-market')

  // Lost response: commits once, console recovers via idempotency query
  await consolePage.getByRole('button', { name: /Test tools/ }).click()
  await consolePage.getByLabel(/Lose next response/).check()
  await enterBid(consolePage, '1.3M')
  await expect(consolePage.getByTestId('current-bid')).toHaveText('$1,300,000')
  await expect(display.getByTestId('display-bid')).toHaveText('$1,300,000')

  // Display network failure → CONNECTION LOST overlay, then recovery
  await consolePage.getByLabel(/Room display offline/).check()
  await expect(display.getByTestId('connection-lost')).toBeVisible({ timeout: 9000 })
  await expect(consolePage.getByText('Disconnected').first()).toBeVisible({ timeout: 9000 })
  await enterBid(consolePage, '1310K') // display misses this
  await shot(display, '04-display-connection-lost')
  await consolePage.getByLabel(/Room display offline/).uncheck()
  await expect(display.getByTestId('connection-lost')).toBeHidden({ timeout: 20000 })
  await expect(display.getByTestId('display-bid')).toHaveText('$1,310,000')

  // Undo with reason
  await consolePage.locator('body').click({ position: { x: 5, y: 500 } })
  await consolePage.keyboard.press('Control+z')
  await consolePage.getByLabel(/Reason/).fill('Auctioneer did not accept')
  await consolePage.getByRole('button', { name: 'Undo bid' }).click()
  await expect(display.getByTestId('display-bid')).toHaveText('$1,300,000')

  // Sold
  await consolePage.getByRole('button', { name: 'Sold…' }).click()
  await consolePage.getByRole('button', { name: 'Confirm sold' }).click()
  await expect(display.getByTestId('display-status')).toHaveText(/Sold/i)
  await shot(display, '05-display-sold')

  // Audit trail
  await consolePage.goto('/auction/reports')
  await expect(consolePage.getByText(/SOLD at \$1,300,000/)).toBeVisible()
  await expect(consolePage.getByText('Auctioneer did not accept')).toBeVisible()
  await shot(consolePage, '06-reports')
})

test('regression: legacy inline photo filling localStorage is migrated and bidding keeps working', async ({ context }) => {
  const page = await context.newPage()
  await signIn(page)
  await expect(page.getByText('Current accepted bid')).toBeVisible()
  // Recreate the broken state: a ~600 KB inline photo duplicated across outbox rows until storage is nearly full.
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('gl-auction-db-v1')!)
    const sid = Object.keys(db.sessions)[0]
    const photo = 'data:image/jpeg;base64,' + 'Q'.repeat(600_000)
    db.sessions[sid].property.heroImage = photo
    const row = { id: 0, sessionId: sid, version: 0, payload: { property: { heroImage: photo } }, createdAt: '', publishedAt: 'x', attempts: 1 }
    db.outbox = [1, 2, 3, 4, 5, 6].map((i) => ({ ...row, id: i }))
    localStorage.setItem('gl-auction-db-v1', JSON.stringify(db))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gl-auction-db-v1')!.includes('data:image'))).toBe(false)

  await page.getByTestId('acquire').click()
  const start = page.getByRole('button', { name: 'Start auction' })
  if (await start.isVisible()) await start.click()
  for (let i = 1; i <= 25; i++) await enterBid(page, `${2000 + i * 5}K`)
  await expect(page.getByTestId('current-bid')).toHaveText('$2,125,000')
  await expect(page.getByText(/QuotaExceeded|STORAGE FULL/)).toHaveCount(0)
  const size = await page.evaluate(() => localStorage.getItem('gl-auction-db-v1')!.length)
  expect(size).toBeLessThan(400_000)
})

test('own lapsed lease is silently re-acquired (no "control lost" dialog)', async ({ context }) => {
  const page = await context.newPage()
  await signIn(page)
  await page.getByTestId('acquire').click()
  await expect(page.getByText(/You have control/)).toBeVisible()
  // Simulate the lease lapsing (e.g. tab throttled / laptop asleep)
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('gl-auction-db-v1')!)
    for (const l of Object.values(db.leases) as { expiresAt: string }[]) if (l) l.expiresAt = new Date(Date.now() - 1000).toISOString()
    localStorage.setItem('gl-auction-db-v1', JSON.stringify(db))
  })
  await expect(page.getByText(/You have control/)).toBeVisible({ timeout: 12000 })
  await page.waitForTimeout(6000)
  await expect(page.getByText('Operator control lost')).toHaveCount(0)
  await expect(page.getByText(/You have control/)).toBeVisible()
})

test('staff pages require sign-in; wrong password is rejected', async ({ page }) => {
  await page.goto('/auction/sessions')
  await expect(page).toHaveURL(/\/auction\/login/)
  await page.getByLabel('Email').fill('admin@demo.local')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(/incorrect/)).toBeVisible()
})

test('second operator is locked out', async ({ context }) => {
  const a = await context.newPage()
  await signIn(a)
  await a.getByTestId('acquire').click()
  await expect(a.getByText(/You have control/)).toBeVisible()

  const b = await context.newPage()
  await signIn(b, 'operator2@demo.local')
  await expect(b.getByText(/Held by/)).toBeVisible()
  await expect(b.locator('#bid-input')).toBeDisabled()
})

test('phone console: calculator keys, + / SET with tap-again-to-send, status buttons', async ({ context }) => {
  // Room display (desktop window) in the same browser — the prototype's data lives in this browser.
  const phone = await context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto('/auction/login?next=/auction/control')
  await phone.getByLabel('Email').fill('admin@demo.local')
  await phone.getByLabel('Password').fill('demo1234')
  await phone.getByRole('button', { name: 'Sign in' }).click()
  await expect(phone.getByTestId('mobile-console')).toBeVisible()
  // no sideways scrolling on a phone
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await phone.getByTestId('acquire').click()
  await phone.getByRole('button', { name: 'Start auction' }).click()
  await expect(phone.getByTestId('mobile-status')).toHaveText(/Live/i)

  const display = await context.newPage()
  await display.goto('/auction/pair')
  const codeEl = display.getByTestId('pair-code')
  await expect(codeEl).not.toContainText('·')
  const code = (await codeEl.innerText()).replace(/\s/g, '')
  // pair from the phone's menu
  await phone.getByTestId('mobile-menu').click()
  await phone.getByLabel('Room screen pairing code').fill(code)
  await phone.getByRole('button', { name: 'Pair room screen' }).click()
  await expect(phone.getByText('Screen paired.')).toBeVisible()
  await phone.getByRole('button', { name: 'Close' }).click()
  await display.waitForURL(/\/auction\/display\//)

  const keys = async (...ks: string[]) => {
    for (const k of ks) await phone.getByRole('button', { name: k, exact: true }).click()
  }
  // + before any bid is refused with a hint
  await phone.getByTestId('key-plus').click()
  await expect(phone.getByText(/press SET/)).toBeVisible()

  // 950K SET → preview only; nothing sent yet
  await keys('9', '5', '0', 'K')
  await expect(phone.getByTestId('mobile-input')).toHaveText('950K')
  await phone.getByTestId('key-set').click()
  await expect(phone.getByTestId('mobile-preview')).toHaveText('$950,000')
  await expect(phone.getByTestId('mobile-current')).toHaveText('No bids')
  // tap again → sent
  await phone.getByTestId('key-set').click()
  await expect(phone.getByTestId('mobile-current')).toHaveText('$950,000')
  await expect(display.getByTestId('display-bid')).toHaveText('$950,000')
  await expect(phone.getByTestId('mobile-input')).toHaveText('0')

  // 1K + → $951,000
  await keys('1', 'K')
  await phone.getByTestId('key-plus').click()
  await expect(phone.getByTestId('mobile-preview')).toHaveText('$951,000')
  // a digit cancels the preview instead of sending
  await keys('0')
  await expect(phone.getByTestId('mobile-preview')).toHaveCount(0)
  await keys('C')
  await keys('1', 'K')
  await phone.getByTestId('key-plus').click()
  await phone.getByTestId('key-plus').click()
  await expect(display.getByTestId('display-bid')).toHaveText('$951,000')

  // + alone = default increment ($10K in the demo session)
  await phone.getByTestId('key-plus').click()
  await expect(phone.getByTestId('mobile-preview')).toHaveText('$961,000')
  await phone.getByTestId('key-plus').click()
  await expect(phone.getByTestId('mobile-current')).toHaveText('$961,000')

  // quick chip
  await phone.getByRole('button', { name: '+25K' }).click()
  await phone.getByRole('button', { name: '✓' }).click()
  await expect(display.getByTestId('display-bid')).toHaveText('$986,000')

  // 1.2M SET (with a "big jump"? no — +214K is below half)
  await keys('1', '.', '2', 'M')
  await phone.getByTestId('key-set').click()
  await phone.getByTestId('key-set').click()
  await expect(display.getByTestId('display-bid')).toHaveText('$1,200,000')

  // lower SET is refused
  await keys('1', 'M')
  await phone.getByTestId('key-set').click()
  await expect(phone.getByText(/Must be higher/)).toBeVisible()
  await keys('C')

  // status buttons
  await phone.getByRole('button', { name: 'On market' }).click()
  await expect(display.getByTestId('display-status')).toHaveText(/On the market/i)
  await phone.getByRole('button', { name: 'Off market' }).click()
  await expect(display.getByTestId('display-status')).not.toHaveText(/On the market/i)

  // menu → undo last bid (reason required)
  await phone.getByTestId('mobile-menu').click()
  await phone.getByRole('button', { name: /Undo last bid/ }).click()
  await phone.getByRole('dialog').getByRole('textbox').fill('Misheard')
  await phone.getByRole('dialog').getByRole('button', { name: 'Undo bid' }).click()
  await expect(display.getByTestId('display-bid')).toHaveText('$986,000')

  // Sold
  await phone.getByRole('button', { name: 'Sold…' }).click()
  await phone.getByRole('button', { name: 'Confirm sold' }).click()
  await expect(display.getByTestId('display-status')).toHaveText(/Sold/i)
  await expect(phone.getByTestId('mobile-status')).toHaveText(/Sold/i)
  await shot(phone, '10-phone-sold')
})
