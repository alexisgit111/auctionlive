/**
 * The one interface the React app talks to. Two implementations:
 *  - mock (in-browser, localStorage)  → local development and Playwright prototype tests
 *  - http (PHP + MySQL on Cloudways)  → shared data across all devices
 */
import type { MockServer } from './mockServer'
import type { User } from './types'

export interface ManagedUser extends User {
  email?: string
  active?: boolean
}

export interface AuthApi {
  me(): Promise<User | null>
  login(email: string, password: string): Promise<User>
  logout(): Promise<void>
  setupStatus(): Promise<{ needsAdmin: boolean }>
  setupAdmin(input: { setupKey: string; name: string; email: string; password: string }): Promise<void>
  listUsers(): Promise<ManagedUser[]>
  createUser(input: { name: string; email: string; role: 'admin' | 'operator'; password: string }): Promise<ManagedUser>
  updateUser(id: string, patch: { name?: string; role?: 'admin' | 'operator'; active?: boolean; password?: string }): Promise<ManagedUser>
  changePassword(currentPassword: string, newPassword: string): Promise<void>
}

export interface MediaFile {
  id: string
  url: string
  name: string
  size: number
}

/** Company-wide room screen media (Room media page). null welcomeImage → built-in image; null pauseMusic → welcome music. */
export interface MediaSettingsView {
  welcomeImage: string | null
  welcomeMusic: MediaFile | null
  pauseMusic: MediaFile | null
}

export interface MediaApi {
  get(): Promise<MediaSettingsView>
  set(patch: { welcomeImage?: string | null; welcomeMusic?: string | null; pauseMusic?: string | null }): Promise<MediaSettingsView>
  uploadMusic(file: File, onProgress?: (fraction: number) => void): Promise<MediaFile>
}

/** The PHP API this build needs (backend/api/index.php API_VERSION). Older → the console shows a warning. */
export const API_VERSION = 4

export interface AppServer {
  mode: 'mock' | 'http'
  staff: MockServer['staff']
  display: MockServer['display']
  auth: AuthApi
  media: MediaApi
  /** Upload a resized image (data: URL); returns the reference to store on the session. */
  uploadImage(dataUrl: string): Promise<string>
  ensureSeed(): Promise<void>
  resetAll(): void
  /** How often the room display checks the server, ms */
  displayPollMs: number
  /** Display heartbeat is a long poll (server answers on change) — near-instant updates. */
  displayLongPoll?: boolean
}
