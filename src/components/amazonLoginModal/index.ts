import { BrowserWindow, remote } from 'electron';

import { currentAmazonRegion } from '~/amazonRegion';
import { ee } from '~/eventEmitter';
import type { AmazonAccount } from '~/models';
import { settingsStore } from '~/store';

const { BrowserWindow: RemoteBrowserWindow } = remote;

const SESSION_PARTITION = 'persist:kindle-highlights';

// Cookies Amazon only sets once a real sign-in has completed. `ubid-main`
// and `session-id` are deliberately excluded: they also appear for
// anonymous visitors.
const AUTH_COOKIE_NAMES = ['sessid-auth', 'x-main', 'at-main'];

export default class AmazonLoginModal {
  private modal: BrowserWindow;
  private waitForSignIn: Promise<boolean>;
  private resolvePromise!: (success: boolean) => void;
  private region: AmazonAccount;

  constructor() {
    this.region = currentAmazonRegion();

    this.waitForSignIn = new Promise(
      (resolve: (success: boolean) => void) => (this.resolvePromise = resolve)
    );

    this.modal = new RemoteBrowserWindow({
      parent: remote.getCurrentWindow(),
      width: 450,
      height: 730,
      webPreferences: {
        partition: SESSION_PARTITION,
      },
      show: false,
    });

    // We can only change title after page is loaded since HTML page has its own title
    this.modal.once('ready-to-show', () => {
      this.modal.setTitle('Connect your Amazon account to Obsidian');
      this.modal.show();
    });

    // Obsidian's main process hardens every webContents it creates, including
    // BrowserWindows opened by plugins, with a `will-navigate` listener that
    // cancels http(s) navigations and hands the URL to shell.openExternal.
    // That ejects the Amazon sign-in flow into the system browser, so the
    // session cookies never land in our `persist:kindle-highlights` partition
    // and `did-navigate` never reaches the Kindle Reader URL (upstream #337).
    // Obsidian registers the listener once at `web-contents-created`, guarded
    // by an `isSecured` flag, so removing it here is sufficient and it is not
    // re-added. See upstream PR #338.
    this.modal.webContents.removeAllListeners('will-navigate');

    // Replace Obsidian's blanket guard with one scoped to this window: keep
    // the sign-in flow inside it, but only for HTTPS URLs on the selected
    // region's Amazon domain. Everything else is refused, and never handed to
    // the system browser.
    this.modal.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedNavigation(url)) {
        event.preventDefault();
      }
    });

    // The plugin owns this window; sign-in must not spawn extra windows.
    try {
      this.modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    } catch (error) {
      console.warn('Kindle: unable to set window open handler', error);
    }

    // If user is on the read.amazon.com url, we can safely assume they are logged in
    this.modal.webContents.on('did-navigate', (_event, url) => {
      if (url.startsWith(this.region.kindleReaderUrl)) {
        this.succeed();
        return;
      }

      // After a password/OTP sign-in Amazon often lands on the store home
      // page instead of returning to the Kindle notebook, so the reader-URL
      // check above never fires. Fall back to the session cookies the
      // sign-in just set on this partition.
      void this.hasAuthenticatedSession().then((authenticated) => {
        if (authenticated) {
          this.succeed();
        }
      });
    });

    this.modal.on('closed', () => {
      ee.off('syncCancelRequested', this.handleCancelDuringLogin);

      // The user may have completed sign-in and then closed the window
      // manually because nothing auto-closed it. The cookies outlive the
      // window, so honour the session rather than reporting a cancel.
      void this.hasAuthenticatedSession().then((authenticated) => {
        if (authenticated) {
          settingsStore.actions.login();
        }
        this.resolvePromise(authenticated);
      });
    });

    ee.on('syncCancelRequested', this.handleCancelDuringLogin);
  }

  private handleCancelDuringLogin = (): void => {
    if (!this.modal.isDestroyed()) {
      this.modal.close();
    }
  };

  private succeed(): void {
    settingsStore.actions.login();

    if (!this.modal.isDestroyed()) {
      this.modal.close();
    }

    this.resolvePromise(true);
  }

  private async hasAuthenticatedSession(): Promise<boolean> {
    try {
      const session = this.modal.isDestroyed()
        ? remote.session.fromPartition(SESSION_PARTITION)
        : this.modal.webContents.session;

      const cookies: { name: string }[] = await session.cookies.get({
        domain: this.region.hostname,
      });

      return cookies.some((cookie) => AUTH_COOKIE_NAMES.includes(cookie.name));
    } catch (error) {
      console.warn('Kindle: unable to inspect login session', error);
      return false;
    }
  }

  private isAllowedNavigation(url: string): boolean {
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') {
        return false;
      }

      const { hostname } = this.region;
      return (
        target.hostname === hostname ||
        target.hostname.endsWith(`.${hostname}`)
      );
    } catch (error) {
      return false;
    }
  }

  async doLogin(): Promise<boolean> {
    try {
      await this.modal.loadURL(this.region.notebookUrl);
    } catch (error) {
      // Swallow error. `loadUrl` is interrupted on successful
      // login as we immediately redirect if user is logged in
    }

    return this.waitForSignIn;
  }
}
