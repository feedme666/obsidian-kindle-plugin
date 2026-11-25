import { BrowserWindow, remote } from 'electron';

import { currentAmazonRegion } from '~/amazonRegion';
import { ee } from '~/eventEmitter';
import type { AmazonAccount } from '~/models';
import { settingsStore } from '~/store';

const { BrowserWindow: RemoteBrowserWindow } = remote;

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
        partition: 'persist:kindle-highlights',
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
        this.modal.close();

        settingsStore.actions.login();

        this.resolvePromise(true);
      }
    });

    this.modal.on('closed', () => {
      ee.off('syncCancelRequested', this.handleCancelDuringLogin);
      this.resolvePromise(false);
    });

    ee.on('syncCancelRequested', this.handleCancelDuringLogin);
  }

  private handleCancelDuringLogin = (): void => {
    if (!this.modal.isDestroyed()) {
      this.modal.close();
    }
  };

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
