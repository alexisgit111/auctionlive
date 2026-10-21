import { chromium, expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Room media against the PHP API: admin uploads the welcome image + music, the console turns the
 * welcome screen / music on and off, and the room screen really plays the audio (checked on the
 * <audio> element). Also checks the "browser blocked sound" path.
 * Run with: E2E_BACKEND=http BASE_URL=… SETUP_KEY=… MEDIA_IMAGE=… MEDIA_MUSIC=… npx playwright test e2e/media.spec.ts
 */
test.skip(process.env.E2E_BACKEND !== 'http' || !process.env.MEDIA_MUSIC, 'http backend + MEDIA_MUSIC file only')

const SHOTS = process.env.SHOTS_DIR
const SETUP_KEY = process.env.SETUP_KEY ?? 'test-setup-key'
const ADMIN = { name: 'Alexis Admin', email: 'admin@goldenlinks.test', password: 'Admin-pass-1' }
const shot = async (p: Page, n: string) => SHOTS && (await p.screenshot({ path: `${SHOTS}/${n}.png` }))

async function adminSignIn(page: Page) {
  const st = await page.request.get('/api/index.php?r=/setup/status')
  if ((await st.json()).needsAdmin) {
    await page.goto('/auction/setup')
    await page.getByLabel(/Setup key/).fill(SETUP_KEY)
    await page.getByLabel('Your name').fill(ADMIN.name)
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel(/^Password/).fill(ADMIN.password)
    await page.getByLabel('Confirm').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Create admin account' }).click()
    await expect(page).toHaveURL(/\/auction\/sessions/)
  } else {
    await page.goto('/auction/login')
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('user-menu')).toBeVisible()
  }
}

const audioState = (room: Page, which: 'welcome' | 'pause') =>
  room.getByTestId(`audio-${which}`).evaluate((a: HTMLAudioElement) => ({ paused: a.paused, t: a.currentTime, vol: a.volume }))

async function pairScreen(screen: Page, console_: Page) {
  await screen.goto('/auction/pair')
  const codeEl = screen.getByTestId('pair-code')
  await expect(codeEl).not.toContainText('·')
  const code = (await codeEl.innerText()).replace(/\s/g, '')
  await console_.getByLabel('Pairing code').fill(code)
  await console_.getByRole('button', { name: 'Approve' }).click()
  await screen.waitForURL(/\/auction\/display\//)
}

test('welcome screen + music on the room screen, controlled from the console', async ({ browser }) => {
  test.setTimeout(150_000)
  const office = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
  await adminSignIn(office)

  // ── Room media page: upload the welcome image and the music (chunked) ──
  await office.goto('/auction/media')
  await office.getByTestId('upload-image').setInputFiles(process.env.MEDIA_IMAGE!)
  await expect(office.getByTestId('media-welcome-preview')).toHaveAttribute('src', /images/, { timeout: 15_000 })
  await office.getByTestId('upload-welcome-music').setInputFiles(process.env.MEDIA_MUSIC!)
  await expect(office.getByTestId('media-track-name').first()).toContainText('.mp3', { timeout: 60_000 })
  await shot(office, 'm01-media-page')

  // ── Session + console ──
  await office.goto('/auction/sessions')
  await office.getByRole('button', { name: 'New session' }).click()
  await office.getByPlaceholder('12 Example Road').fill('9 Welcome Way')
  await office.getByLabel('Suburb').fill('Mt Roskill')
  await office.getByRole('button', { name: 'Save session' }).click()
  await expect(office.getByText('9 Welcome Way, Mt Roskill')).toBeVisible()
  await office.goto('/auction/control')
  const label = await office.locator('#session option', { hasText: '9 Welcome Way' }).innerText()
  await office.locator('#session').selectOption({ label })
  await office.getByTestId('acquire').click()
  await expect(office.getByText(/You have control/)).toBeVisible()

  // ── Room screen computer with sound allowed (as configured in Chrome) ──
  const loud: Browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const room = await (await loud.newContext({ viewport: { width: 1600, height: 900 }, baseURL: process.env.BASE_URL })).newPage()
  await pairScreen(room, office)

  // Welcome ON → image + music
  await office.getByTestId('toggle-welcome').click()
  await expect(room.getByTestId('welcome-overlay')).toHaveAttribute('data-on', 'true', { timeout: 5000 })
  await expect.poll(async () => (await audioState(room, 'welcome')).t, { timeout: 15_000 }).toBeGreaterThan(0.5)
  expect((await audioState(room, 'welcome')).paused).toBe(false)
  await expect(office.getByTestId('screen-audio')).toContainText('Playing', { timeout: 10_000 })
  await room.waitForTimeout(1500)
  await shot(room, 'm02-room-welcome')
  await shot(office, 'm03-console-welcome')

  // Start auction → welcome closes, music fades out
  await office.getByRole('button', { name: 'Start auction' }).click()
  await expect(room.getByTestId('welcome-overlay')).toHaveAttribute('data-on', 'false', { timeout: 5000 })
  await expect.poll(async () => (await audioState(room, 'welcome')).paused, { timeout: 6000 }).toBe(true)

  // Pause → music starts by itself; button stops it; resume keeps it off
  await office.getByRole('button', { name: /Pause/ }).click()
  await expect.poll(async () => (await audioState(room, 'pause')).paused, { timeout: 8000 }).toBe(false)
  await expect(office.getByTestId('toggle-music')).toContainText('ON')
  // volume 40 → reaches the screen
  await office.getByLabel('Room screen volume').fill('40')
  await expect.poll(async () => (await audioState(room, 'pause')).vol, { timeout: 8000 }).toBeCloseTo(0.4, 1)
  await office.getByTestId('toggle-music').click()
  await expect.poll(async () => (await audioState(room, 'pause')).paused, { timeout: 6000 }).toBe(true)
  await office.getByRole('button', { name: /Music OFF/ }).click()
  await expect.poll(async () => (await audioState(room, 'pause')).paused, { timeout: 6000 }).toBe(false)
  await office.getByRole('button', { name: /Resume/ }).click()
  await expect.poll(async () => (await audioState(room, 'pause')).paused, { timeout: 6000 }).toBe(true)
  await loud.close()

  // ── A screen whose browser blocks sound: prompt on screen, warning on the console, one click fixes it ──
  // Chrome under automation always allows autoplay, so this screen simulates the real policy:
  // play() is refused with NotAllowedError until someone clicks / presses a key on the page.
  const strict = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  const ctx2 = await strict.newContext({ viewport: { width: 1600, height: 900 }, baseURL: process.env.BASE_URL })
  await ctx2.addInitScript(() => {
    let activated = false
    const mark = () => (activated = true)
    window.addEventListener('pointerdown', mark, true)
    window.addEventListener('keydown', mark, true)
    const real = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (!activated) return Promise.reject(new DOMException('play() needs a user gesture', 'NotAllowedError'))
      return real.call(this)
    }
  })
  const room2 = await ctx2.newPage()
  await pairScreen(room2, office)
  await office.getByTestId('toggle-welcome').click()
  await expect(room2.getByTestId('sound-blocked')).toBeVisible({ timeout: 10_000 })
  await expect(office.getByTestId('screen-audio')).toContainText('blocked', { timeout: 10_000 })
  await shot(office, 'm04-console-blocked')
  await room2.getByTestId('sound-blocked').click()
  await expect.poll(async () => (await audioState(room2, 'welcome')).paused, { timeout: 8000 }).toBe(false)
  await expect(office.getByTestId('screen-audio')).toContainText('Playing', { timeout: 10_000 })
  await strict.close()
})
