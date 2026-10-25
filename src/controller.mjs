const STATUS_EXPRESSION = 'window.__codexOpenSea?.status() ?? null';

function failureSummary(failures) {
  const error = new AggregateError(failures.map(item => item.error),
    `${failures.length} Codex window(s) could not be updated or restored: ${failures[0]?.error?.message || 'Unknown error'}`);
  error.failures = failures;
  return error;
}

function within(promise, deadline, message) {
  let timer;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(new Error(message));
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), remaining); }),
  ]).finally(() => clearTimeout(timer));
}

/** The caller serializes normal operations; shutdown immediately fences new work. */
export class SessionController {
  constructor({ payload, getSettings, profileDir, discoverCodex, launchCodex,
    verifyEndpoint, allocatePort, createConnection, loadInstance = async () => null,
    saveInstance = async () => {}, removeInstance = async () => {}, processExists = () => true }) {
    Object.assign(this, { payload, getSettings, profileDir, discoverCodex, launchCodex,
      verifyEndpoint, allocatePort, createConnection, loadInstance, saveInstance, removeInstance, processExists });
    this.launch = null;
    this.connection = null;
    this.sessions = new Map();
    this.enabled = false;
    this.closing = false;
    this.closed = false;
    this.shutdownPromise = null;
  }

  assertOpen() {
    if (this.closing || this.closed) throw new Error('The skin controller is shutting down.');
  }

  launchAlive() {
    const process = this.launch?.process;
    return !!process && process.exitCode == null && process.signalCode == null
      && (!this.launch.recovered || this.processExists(process.pid));
  }

  async resume({ cleanup = false } = {}) {
    if (this.launch) return;
    const saved = await this.loadInstance();
    if (!saved) return;
    if (!Number.isInteger(saved.pid) || saved.pid <= 1 || !Number.isInteger(saved.port)
      || saved.port < 1024 || saved.port > 65535 || saved.profileDir !== this.profileDir
      || typeof saved.browserId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(saved.browserId)
      || !this.processExists(saved.pid)) {
      await this.removeInstance();
      return;
    }
    const installation = await this.discoverCodex();
    const launch = { process:{pid:saved.pid,exitCode:null,signalCode:null}, pid:saved.pid,
      port:saved.port, profileDir:this.profileDir, installation, recovered:true };
    const verify = () => this.verifyEndpoint({ installation, port:saved.port, process:launch, timeoutMs:10000 });
    const identity = await verify();
    if (identity.browserId !== saved.browserId) throw new Error('The previous managed Codex instance identity changed.');
    if (this.closed || (!cleanup && this.closing)) throw new Error('The skin controller is shutting down.');
    this.launch = launch;
    this.connection = this.createConnection({ identity, verify });
  }

  forget(id) {
    const record = this.sessions.get(id);
    if (!record) return;
    record.session.close();
    this.connection?.sessions?.delete(record.session);
    this.sessions.delete(id);
  }

  closeConnection() {
    this.connection?.close();
    this.connection = null;
    this.sessions.clear();
  }

  async connect({ cleanup = false } = {}) {
    if (this.closed || (!cleanup && this.closing)) throw new Error('The skin controller is shutting down.');
    if (!this.launchAlive()) throw new Error('The managed Codex instance is no longer running.');
    if (this.connection && !this.connection.closed) {
      try { await this.connection.verifyIdentity(); return; }
      catch { this.closeConnection(); }
    } else if (this.connection) this.closeConnection();
    const verify = () => this.verifyEndpoint({ installation:this.launch.installation,
      port:this.launch.port, process:this.launch, timeoutMs:10000 });
    const identity = await verify();
    if (this.closed || (!cleanup && this.closing)) throw new Error('The skin controller is shutting down.');
    await this.saveInstance({ pid:this.launch.process.pid, port:this.launch.port,
      profileDir:this.profileDir, browserId:identity.browserId });
    if (this.closed || (!cleanup && this.closing)) throw new Error('The skin controller is shutting down.');
    this.connection = this.createConnection({ identity, verify });
  }

  async start() {
    this.assertOpen();
    await this.resume();
    this.assertOpen();
    if (!this.launchAlive()) {
      this.closeConnection();
      const installation = await this.discoverCodex();
      this.assertOpen();
      const port = await this.allocatePort();
      this.assertOpen();
      this.launch = await this.launchCodex({ installation, profileDir:this.profileDir, port });
      this.assertOpen();
    }
    // Verification failures leave the owned launch available for a later retry.
    await this.connect();
    this.assertOpen();
    this.enabled = true;
    return this.sync();
  }

  async recordFor(target, { cleanup = false } = {}) {
    let record = this.sessions.get(target.id);
    if (record?.session.closed) { this.forget(target.id); record = null; }
    if (!record) {
      const session = await this.connection.attach(target);
      if (this.closed || (!cleanup && this.closing)) {
        session.close();
        throw new Error('The skin controller is shutting down.');
      }
      record = { session, settings:null };
      this.sessions.set(target.id, record);
    }
    return record;
  }

  async withSession(target, action, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.closed || (!options.cleanup && this.closing)) throw new Error('The skin controller is shutting down.');
      try { return await action(await this.recordFor(target, options)); }
      catch (error) { lastError = error; this.forget(target.id); }
    }
    throw lastError;
  }

  async sync() {
    this.assertOpen();
    if (!this.enabled) return null;
    if (!this.connection || this.connection.closed) await this.connect();
    const targets = await this.connection.targets();
    this.assertOpen();
    const ids = new Set(targets.map(target => target.id));
    for (const id of this.sessions.keys()) if (!ids.has(id)) this.forget(id);
    const settings = this.getSettings();
    const failures = [];
    const counts = { ready:0, fallback:0, initializing:0, waiting:0, failed:0 };
    const rendererErrors = [];
    for (const target of targets) {
      this.assertOpen();
      try {
        const result = await this.withSession(target, async record => {
          this.assertOpen();
          let installation;
          if (record.settings !== settings) {
            // install replaces the old new-document script as well as the live settings.
            installation = await record.session.install(this.payload, settings);
            this.assertOpen();
            record.settings = settings;
          }
          let current = await record.session.evaluate(STATUS_EXPRESSION);
          this.assertOpen();
          if (!current) {
            installation = await record.session.install(this.payload, settings);
            this.assertOpen();
            current = await record.session.evaluate(STATUS_EXPRESSION);
          }
          // On the welcome page the installer deliberately waits before creating the API.
          return current ?? (installation?.reason === 'shell-not-ready' ? { state:'waiting-shell' } : null);
        });
        if (['ready', 'fallback', 'initializing'].includes(result?.state)) counts[result.state]++;
        else if (result?.state === 'waiting-shell') counts.waiting++;
        else {
          counts.failed++;
          rendererErrors.push({ targetId:target.id, message:result?.error || result?.video?.error || result?.ocean?.error
            || (result ? `Unexpected renderer state: ${result.state}` : 'Renderer status is unavailable after installation.') });
        }
      } catch (error) { failures.push({ targetId:target.id, error }); }
    }
    if (failures.length) throw failureSummary(failures);
    // A healthy window must not conceal another window's fallback or renderer failure.
    const phase = counts.failed ? 'error' : counts.fallback ? 'fallback'
      : counts.initializing ? 'initializing' : counts.ready ? 'ready' : 'waiting';
    return { phase, ...counts, total:targets.length, rendererErrors,
      version:this.launch?.installation.version };
  }

  async restore({ cleanup = false } = {}) {
    if (!cleanup) this.assertOpen();
    this.enabled = false;
    await this.resume({ cleanup });
    if (!this.launch) return { phase:'idle', restored:0, total:0 };
    if (!this.launchAlive()) {
      this.closeConnection();
      await this.removeInstance();
      return { phase:'restored', restored:0, total:0 };
    }
    await this.connect({ cleanup });
    const targets = await this.connection.targets();
    if (this.closed) throw new Error('The skin controller is closed.');
    const ids = new Set(targets.map(target => target.id));
    for (const id of this.sessions.keys()) if (!ids.has(id)) this.forget(id);
    // A failed/vanished window must not prevent the other windows from being restored.
    const results = await Promise.allSettled(targets.map(target => this.withSession(target, async record => {
      const result = await record.session.uninstall();
      record.settings = null;
      const remaining = await record.session.evaluate(STATUS_EXPRESSION);
      if (remaining) throw new Error('The renderer is still present after restore.');
      return result;
    }, { cleanup })));
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ targetId:targets[index].id, error:result.reason }] : []);
    if (failures.length) throw failureSummary(failures);
    return { phase:'restored', restored:results.length, total:targets.length };
  }

  beginShutdown() {
    this.closing = true;
    this.enabled = false;
  }

  shutdown({ pending = Promise.resolve(), timeoutMs = 10000 } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.beginShutdown();
    const duration = Math.max(50, Math.min(15000, Number(timeoutMs) || 10000));
    const deadline = Date.now() + duration;
    this.shutdownPromise = (async () => {
      try {
        // Reserve most of the deadline for restore even if an earlier operation hangs.
        await within(Promise.resolve(pending).catch(() => {}),
          Math.min(deadline, Date.now() + duration / 3), 'Pending operation did not finish before shutdown.').catch(() => {});
        return await within(this.restore({ cleanup:true }), deadline, 'Skin cleanup timed out; not all windows were confirmed restored.');
      } finally {
        this.closed = true;
        this.closeConnection();
      }
    })();
    return this.shutdownPromise;
  }
}
