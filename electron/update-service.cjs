const fs = require("node:fs");
const path = require("node:path");
const {
  OFFICIAL_RELEASE_PAGE,
  ReleaseSecurityError,
  compareVersions,
  parseVersion,
  sha256FileAsync
} = require("./release-security.cjs");

class OfficialUpdateService {
  constructor(options) {
    this.updater = options.updater;
    this.releaseSecurity = options.releaseSecurity;
    this.feedOptions = options.feedOptions || null;
    this.isPackaged = Boolean(options.isPackaged);
    this.currentVersion = String(options.currentVersion || "");
    this.canInstallNow = typeof options.canInstallNow === "function" ? options.canInstallNow : () => true;
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : () => {};
    this.installDelayMs = Math.max(0, Number(options.installDelayMs ?? 800));
    this.started = false;
    this.checkPromise = null;
    this.installing = false;
    this.installTimer = null;
    this.downloadedFile = null;
    this.updateApproved = false;
    this.updateState = this.makeState(this.isPackaged ? "idle" : "development", this.isPackaged
      ? "启动后会自动检查官方更新"
      : "开发模式不运行安装包更新");
    this.listeners = {
      checking: () => this.setState("checking", "正在检查官方更新…"),
      available: info => this.onUpdateAvailable(info),
      unavailable: info => this.onUpdateUnavailable(info),
      progress: progress => this.onDownloadProgress(progress),
      downloaded: info => { void this.verifyAndInstall(info); },
      error: error => this.onError(error)
    };
  }

  makeState(status, message, extra = {}) {
    return {
      status,
      message: String(message || ""),
      currentVersion: this.currentVersion,
      latestVersion: null,
      percent: null,
      officialReleasePage: OFFICIAL_RELEASE_PAGE,
      ...extra
    };
  }

  state() {
    return { ...this.updateState };
  }

  setState(status, message, extra = {}) {
    this.updateState = this.makeState(status, message, extra);
    this.onStateChange(this.state());
    return this.state();
  }

  bind() {
    this.updater.on("checking-for-update", this.listeners.checking);
    this.updater.on("update-available", this.listeners.available);
    this.updater.on("update-not-available", this.listeners.unavailable);
    this.updater.on("download-progress", this.listeners.progress);
    this.updater.on("update-downloaded", this.listeners.downloaded);
    this.updater.on("error", this.listeners.error);
  }

  configureUpdater() {
    if (this.feedOptions && typeof this.updater.setFeedURL === "function") {
      this.updater.setFeedURL(this.feedOptions);
    }
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
  }

  async start() {
    if (!this.isPackaged || this.started) return this.state();
    this.started = true;
    this.configureUpdater();
    this.bind();
    return this.checkNow();
  }

  async checkNow() {
    if (!this.isPackaged) return this.state();
    if (!this.started) {
      this.started = true;
      this.configureUpdater();
      this.bind();
    }
    if (this.installing) return this.state();
    if (["downloading", "verifying", "installing", "ready"].includes(this.updateState.status)) return this.state();
    if (this.downloadedFile) return this.state();
    if (this.checkPromise) return this.checkPromise;
    this.setState("checking", "正在检查官方更新…");
    this.checkPromise = (async () => {
      try {
        await this.updater.checkForUpdates();
      } catch (error) {
        this.onError(error);
      } finally {
        this.checkPromise = null;
      }
      return this.state();
    })();
    return this.checkPromise;
  }

  onUpdateAvailable(info) {
    const version = parseVersion(info?.version)?.raw || null;
    this.updateApproved = false;
    this.setState("available", version ? `发现新版本 v${version}，可由您选择是否更新` : "发现新的官方版本，可由您选择是否更新", {
      latestVersion: version,
      percent: null
    });
  }

  async requestUpdate() {
    if (!this.isPackaged) return this.state();
    if (!this.started) await this.start();
    if (this.installing) return this.state();
    if (this.downloadedFile) {
      this.updateApproved = true;
      if (this.canInstallNow()) this.scheduleInstall(this.updateState.latestVersion || this.currentVersion);
      return this.state();
    }
    if (this.updateState.status !== "available") {
      await this.checkNow();
      if (this.updateState.status !== "available") return this.state();
    }
    this.updateApproved = true;
    const version = this.updateState.latestVersion;
    this.setState("downloading", version ? `正在下载 v${version}…` : "正在下载官方更新…", {
      latestVersion: version,
      percent: 0
    });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.onError(error);
    }
    return this.state();
  }

  onUpdateUnavailable(info) {
    if (this.installing || this.downloadedFile) return;
    const version = parseVersion(info?.version)?.raw || this.currentVersion;
    this.setState("current", "当前已是最新官方版本", { latestVersion: version });
  }

  onDownloadProgress(progress) {
    const percent = Math.min(100, Math.max(0, Number(progress?.percent || 0)));
    const version = this.updateState.latestVersion;
    this.setState("downloading", `正在下载${version ? ` v${version}` : "官方更新"}（${percent.toFixed(0)}%）…`, {
      latestVersion: version,
      percent,
      transferred: Number(progress?.transferred || 0),
      total: Number(progress?.total || 0)
    });
  }

  onError(error) {
    if (this.installing) return;
    const detail = String(error?.message || error || "未知错误").replace(/\s+/g, " ").slice(0, 300);
    this.setState("error", `版本更新暂未完成：${detail}。请检查网络后重试。`, {
      latestVersion: this.updateState.latestVersion,
      error: detail
    });
  }

  async verifyAndInstall(info) {
    if (this.installing) return;
    if (!this.updateApproved) {
      const version = parseVersion(info?.version)?.raw || this.updateState.latestVersion;
      this.setState("available", version ? `发现新版本 v${version}，可由您选择是否更新` : "发现新的官方版本，可由您选择是否更新", {
        latestVersion: version,
        percent: null
      });
      return;
    }
    try {
      const version = parseVersion(info?.version)?.raw;
      if (!version || compareVersions(version, this.currentVersion) <= 0) {
        throw new ReleaseSecurityError("update-version-mismatch", "下载的更新版本号无效");
      }
      const signedUpdate = await this.releaseSecurity.fetchSignedUpdate(version);
      const installerPath = path.resolve(String(info?.downloadedFile || ""));
      if (!installerPath || !fs.existsSync(installerPath) || !fs.statSync(installerPath).isFile()) {
        throw new ReleaseSecurityError("missing-update-installer", "自动更新缓存中缺少安装包");
      }
      if (path.basename(installerPath).toLocaleLowerCase("en-US") !== signedUpdate.installer.name.toLocaleLowerCase("en-US")) {
        throw new ReleaseSecurityError("update-installer-name-mismatch", "下载的安装包名称与官方签名清单不一致");
      }
      this.setState("verifying", `正在验证 v${version} 安装包的官方签名与完整性…`, {
        latestVersion: version,
        percent: 100
      });
      const stat = fs.statSync(installerPath);
      const digest = await sha256FileAsync(installerPath);
      if (stat.size !== signedUpdate.installer.size || digest !== signedUpdate.installer.sha256) {
        throw new ReleaseSecurityError("update-installer-mismatch", "下载的安装包未通过官方签名清单完整性验证");
      }
      this.downloadedFile = installerPath;
      // Installation on quit is enabled only after the player explicitly chose
      // the one-click update action.
      this.updater.autoInstallOnAppQuit = true;
      if (!this.canInstallNow()) {
        this.setState("ready", `v${version} 已验证，将在退出当前账号或关闭工具后自动安装`, {
          latestVersion: version,
          percent: 100,
          installDeferred: true
        });
        return;
      }
      this.scheduleInstall(version);
    } catch (error) {
      this.downloadedFile = null;
      this.updater.autoInstallOnAppQuit = false;
      this.onError(error);
    }
  }

  scheduleInstall(version) {
    if (this.installing || this.installTimer) return;
    this.setState("installing", `v${version} 已验证，正在自动安装并重启…`, {
      latestVersion: version,
      percent: 100
    });
    this.installTimer = setTimeout(() => {
      this.installTimer = null;
      if (!this.canInstallNow()) {
        this.setState("ready", `v${version} 已验证，将在关闭工具后自动安装`, {
          latestVersion: version,
          percent: 100,
          installDeferred: true
        });
        return;
      }
      this.installing = true;
      this.updater.quitAndInstall(true, true);
    }, this.installDelayMs);
  }

  shutdown() {
    if (this.installTimer) clearTimeout(this.installTimer);
    this.installTimer = null;
    if (!this.started) return;
    this.updater.removeListener("checking-for-update", this.listeners.checking);
    this.updater.removeListener("update-available", this.listeners.available);
    this.updater.removeListener("update-not-available", this.listeners.unavailable);
    this.updater.removeListener("download-progress", this.listeners.progress);
    this.updater.removeListener("update-downloaded", this.listeners.downloaded);
    this.updater.removeListener("error", this.listeners.error);
  }
}

module.exports = { OfficialUpdateService };
