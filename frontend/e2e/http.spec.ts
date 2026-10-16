import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Full-stack test against the PHP + MySQL API. Each browser *context* is a separate
 * computer (own cookies, own storage) — exactly the auction-day setup.
 * Run with: E2E_BACKEND=http BASE_URL=http://localhost:8080 SETUP_KEY=... npx playwright test e2e/http.spec.ts
 * (database must start empty)
 */
test.skip(process.env.E2E_BACKEND !== 'http', 'http backend only')

const SHOTS = process.env.SHOTS_DIR
const SETUP_KEY = process.env.SETUP_KEY ?? 'test-setup-key'
const ADMIN = { name: 'Alexis Admin', email: 'admin@goldenlinks.test', password: 'Admin-pass-1' }

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function newComputer(browser: Browser, viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport })
  return ctx.newPage()
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auction/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('user-menu')).toBeVisible()
}

async function enterBid(page: Page, amount: string) {
  const input = page.locator('#bid-input')
  await input.fill(amount)
  await input.press('Enter')
  await input.press('Enter')
  await expect(input).toHaveValue('')
}

test('first-time setup, staff accounts, shared sessions, two-computer auction', async ({ browser }) => {
  test.setTimeout(120_000)

  // ── First-time setup creates the admin ──
  const office = await newComputer(browser)
  await office.goto('/auction/control')
  await expect(office).toHaveURL(/\/auction\/setup/)
  await office.getByLabel(/Setup key/).fill(SETUP_KEY)
  await office.getByLabel('Your name').fill(ADMIN.name)
  await office.getByLabel('Email').fill(ADMIN.email)
  await office.getByLabel(/^Password/).fill(ADMIN.password)
  await office.getByLabel('Confirm').fill(ADMIN.password)
  await office.getByRole('button', { name: 'Create admin account' }).click()
  await expect(office).toHaveURL(/\/auction\/sessions/)
  await shot(office, 'h01-sessions-empty')

  // ── Admin adds an operator ──
  await office.getByRole('link', { name: 'Users' }).click()
  await office.getByRole('button', { name: 'Add staff member' }).click()
  await office.getByLabel('Name').fill('Vicky Operator')
  await office.getByLabel(/Email/).fill('vicky@goldenlinks.test')
  await office.getByLabel(/Temporary password/).fill('Operator-pass')
  await office.getByRole('button', { name: 'Create account' }).click()
  await expect(office.getByText('vicky@goldenlinks.test')).toBeVisible()
  await shot(office, 'h02-users')

  // ── Admin creates a session (stored on the server) ──
  await office.getByRole('link', { name: 'Sessions' }).click()
  await office.getByRole('button', { name: 'New session' }).click()
  await office.getByPlaceholder('12 Example Road').fill('85 Rosier Road')
  await office.getByLabel('Suburb').fill('Glen Eden')
  await office.getByLabel('Bedrooms').fill('4')
  await office.getByLabel('Bathrooms').fill('2')
  await office.getByRole('button', { name: '+ Add salesperson' }).click()
  await office.getByLabel('Salesperson 1 name').fill('Jane Smith')
  await office.getByRole('button', { name: 'Save session' }).click()
  await expect(office.getByText('85 Rosier Road, Glen Eden')).toBeVisible()

  // ── Operator on a different computer sees the same session ──
  const console_ = await newComputer(browser)
  await signIn(console_, 'vicky@goldenlinks.test', 'Operator-pass')
  await expect(console_.locator('#session')).toContainText('85 Rosier Road')
  await console_.getByTestId('acquire').click()
  await expect(console_.getByText(/You have control/)).toBeVisible()
  await console_.getByRole('button', { name: 'Start auction' }).click()

  // ── Room display computer pairs (no staff login) ──
  const room = await newComputer(browser, { width: 1600, height: 900 })
  await room.goto('/auction/pair')
  const codeEl = room.getByTestId('pair-code')
  await expect(codeEl).not.toContainText('·')
  const code = (await codeEl.innerText()).replace(/\s/g, '')
  await console_.getByLabel('Pairing code').fill(code)
  await console_.getByRole('button', { name: 'Approve' }).click()
  await room.waitForURL(/\/auction\/display\//)
  await expect(room.getByTestId('display-status')).toHaveText(/Auction live/i)

  // ── Bids reach the other computer ──
  await enterBid(console_, '950K')
  await expect(room.getByTestId('display-bid')).toHaveText('$950,000', { timeout: 5000 })
  await enterBid(console_, '1.1M')
  await console_.getByRole('button', { name: 'On the market' }).click()
  await enterBid(console_, '1125K')
  await expect(room.getByTestId('display-bid')).toHaveText('$1,125,000', { timeout: 5000 })
  await expect(room.getByTestId('display-status')).toHaveText(/On the market/i)
  await expect(room.getByTestId('display-salespeople')).toContainText('Jane Smith')
  await expect(console_.getByText('Synced')).toBeVisible({ timeout: 8000 })
  await shot(console_, 'h03-console')
  await shot(room, 'h04-display')

  // ── Office admin sees live progress & audit trail ──
  await office.getByRole('link', { name: 'Reports' }).click()
  await expect(office.getByText('Bid #3 accepted: $1,125,000')).toBeVisible()
  await expect(office.getByText('Vicky Operator').first()).toBeVisible()

  // ── Sign out protects the console ──
  await console_.getByTestId('user-menu').click()
  await console_.getByRole('button', { name: 'Sign out' }).click()
  await expect(console_).toHaveURL(/\/auction\/login/)
  await console_.goto('/auction/control')
  await expect(console_).toHaveURL(/\/auction\/login/)
  await shot(console_, 'h05-login')
})
