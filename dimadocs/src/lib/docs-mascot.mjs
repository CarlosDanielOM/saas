/** A page-local SVG companion. It moves only after an explicit guide action. */
const STATES = new Set(['idle', 'thinking', 'reading', 'speaking', 'happy', 'error']);

class DocsMascotElement extends HTMLElement {
  connectedCallback() {
    if (this.events) return; // Moving the same custom element must not bind twice.
    this.events = new AbortController();
    const options = { signal: this.events.signal };
    this.labels = JSON.parse(this.dataset.labels || '{}');
    this.trigger = this.querySelector('.dm-trigger');
    this.art = this.querySelector('.dm-art');
    this.bubble = this.querySelector('[data-mascot-bubble]');
    this.tour = this.querySelector('.dm-tour');
    this.next = this.querySelector('[data-mascot-next]');
    this.done = this.querySelector('[data-mascot-done]');
    if (!this.homeMarker) {
      this.homeMarker = document.createComment('docs mascot home');
      this.before(this.homeMarker);
    }
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    try { this.userPaused = localStorage.getItem('docs-mascot:motion') === 'paused'; } catch { this.userPaused = false; }
    this.motion.addEventListener('change', () => { this.cancelTravel(); this.pause(); }, options);
    document.addEventListener('docs-mascot:motion', (event) => {
      this.userPaused = Boolean(event.detail?.paused);
      if (this.userPaused) this.cancelTravel();
      this.pause();
    }, options);
    document.addEventListener('docs-mascot:state', (event) => this.setState(event.detail), options);
    document.addEventListener('docs-mascot:guide', (event) => this.guide(event.detail), options);
    document.addEventListener('docs-mascot:home', () => this.home(), options);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancelTravel();
      this.pause();
    }, options);
    window.addEventListener('resize', () => this.cancelTravel(), options);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.dataset.mode === 'guide' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        this.finish();
      }
    }, options);
    this.trigger.addEventListener('pointerenter', () => this.greet(), options);
    this.trigger.addEventListener('focus', () => this.greet(), options);
    this.next.addEventListener('click', () => document.dispatchEvent(new CustomEvent('docs-mascot:next')), options);
    this.done.addEventListener('click', () => this.finish(), options);
    this.observer = new IntersectionObserver(([entry]) => { this.offscreen = !entry.isIntersecting; this.pause(); });
    this.observer.observe(this);
    this.pause();
  }

  disconnectedCallback() {
    // DOM reparenting triggers disconnect/connect; a removed page does not.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.events?.abort();
      this.events = null;
      this.observer?.disconnect();
      this.cancelTravel();
      clearTimeout(this.greetingTimer);
      this.target?.classList.remove('dm-guide-target');
      this.stage?.remove();
    });
  }

  pause() { this.dataset.paused = String(document.hidden || !!this.offscreen || this.userPaused || this.motion.matches); }

  greet() {
    if (this.motion.matches || this.userPaused || this.dataset.mode === 'guide') return;
    this.dataset.greeting = 'true';
    clearTimeout(this.greetingTimer);
    this.greetingTimer = setTimeout(() => delete this.dataset.greeting, 1050);
  }

  setState(detail = {}) {
    const state = STATES.has(detail.state) ? detail.state : 'idle';
    this.dataset.state = state;
    if (typeof detail.expanded === 'boolean') {
      this.dataset.expanded = String(detail.expanded);
      this.trigger.setAttribute('aria-expanded', String(detail.expanded));
    }
    this.bubble.textContent = detail.label || this.labels.ask;
  }

  cancelTravel() {
    this.travel?.cancel();
    this.travel = null;
    delete this.dataset.moving;
  }

  guide({ target, label, index = 0, total = 1 } = {}) {
    if (!(target instanceof HTMLElement) || !target.isConnected || !target.closest('main')) return;
    const before = this.art.getBoundingClientRect();
    this.cancelTravel();
    this.target?.classList.remove('dm-guide-target');
    this.target = target;
    this.target.classList.add('dm-guide-target');
    this.dataset.mode = 'guide';
    this.dataset.expanded = 'false';
    this.trigger.setAttribute('aria-expanded', 'false');
    this.tour.hidden = false;
    this.querySelector('[data-mascot-counter]').textContent = `${this.labels.section} ${index + 1} / ${total}`;
    this.querySelector('[data-mascot-guide-label]').textContent = label || target.textContent.trim();
    this.next.hidden = index + 1 >= total;
    const stage = document.createElement('div');
    stage.className = 'dm-guide-stage';
    stage.dataset.docsMascotStage = '';
    // Starlight headings share a flex wrapper with their permalink. Reserve a
    // full block after that wrapper, rather than squeezing into the heading row.
    const headingBlock = target.closest('.sl-heading-wrapper') || target;
    headingBlock.after(stage);
    stage.append(this);
    this.stage?.remove();
    this.stage = stage;
    const staticMotion = this.motion.matches || this.userPaused;
    target.scrollIntoView({ block: 'start', behavior: staticMotion ? 'instant' : 'smooth' });
    if (!staticMotion) {
      const after = this.art.getBoundingClientRect();
      const x = Math.max(-innerWidth, Math.min(innerWidth, before.x - after.x));
      const y = Math.max(-innerHeight, Math.min(innerHeight, before.y - after.y));
      this.dataset.moving = 'true';
      this.travel = this.art.animate([
        { transform: `translate(${x}px, ${y}px) rotate(-5deg)`, opacity: 0.4 },
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      ], { duration: 540, easing: 'cubic-bezier(.2,.75,.25,1)' });
      this.travel.finished.then(() => { delete this.dataset.moving; }).catch(() => {});
    }
    (this.next.hidden ? this.done : this.next).focus({ preventScroll: true });
    this.offscreen = false;
    this.pause();
  }

  home() {
    if (this.dataset.mode !== 'guide') return;
    const focused = this.contains(document.activeElement);
    this.cancelTravel();
    this.target?.classList.remove('dm-guide-target');
    this.target = null;
    this.dataset.mode = 'dock';
    this.tour.hidden = true;
    if (this.homeMarker?.isConnected) this.homeMarker.after(this);
    this.stage?.remove();
    this.stage = null;
    if (focused) this.trigger.focus({ preventScroll: true });
  }

  finish() {
    this.home();
    document.dispatchEvent(new CustomEvent('docs-mascot:end'));
  }
}

if (!customElements.get('docs-mascot')) customElements.define('docs-mascot', DocsMascotElement);
