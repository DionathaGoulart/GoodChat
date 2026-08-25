// What counts as having read a message.
//
// This used to be a footnote. Reading only moved a tick from one glyph to
// another, so "the tab is visible and here is the newest message" was a fine
// answer, and the thread sent one watermark id for the whole scrollback.
//
// Reading now deletes (PRD §3.9): three hours after this module reports a
// message, that message is gone from both sides for good. So the answer has to
// be worth that, and the watermark had to go — landing on a thread from a
// notification would have condemned every message above the newest bubble,
// including ones the person never scrolled to. Ids are named one at a time,
// and only after all four of these hold at once:
//
//   1. the plaintext is on screen. A sealed bubble is a placeholder, and a
//      device that cannot decrypt must never be the one that deletes — that is
//      the difference between "I read it" and "I was handed some bytes". The
//      caller enforces this one by only watching what it actually painted;
//   2. at least half the bubble is in the viewport. Not a pixel of it: a
//      message clipped by the composer at the bottom of a fast scroll has been
//      past somebody's eyes, not read;
//   3. the window has focus. A thread left open behind another window is not
//      being read, and it is exactly the state a laptop spends its night in;
//   4. all of the above held continuously for a second. Flicking through a
//      scrollback is not reading, and this is the cheapest way to say so.
//
// The dwell is deliberately checked by one polling loop rather than a timer per
// element. A thread has fifty bubbles; it does not need fifty timers, and the
// loop is also the natural place to notice that focus was lost — which resets
// every dwell, because half a second before switching windows plus half a
// second after coming back is not a second of reading.

/** Fraction of a bubble that has to be on screen for it to count. */
const VISIBLE_RATIO = 0.5

/** How long that has to hold, continuously. */
const DWELL_MS = 1000

/** How often the dwell is checked. */
const POLL_MS = 250

/**
 * How long reports are collected before being sent. A thread painting a
 * scrollback crosses several bubbles' dwell within a few hundred milliseconds,
 * and they belong in one frame.
 */
const FLUSH_MS = 500

/**
 * How long to wait before offering a refused batch again. A receipt is only
 * sendable on an open socket, and dropping one because the connection blinked
 * would leave a message the person has read sitting on its full seven days
 * with nothing left to ever report it.
 */
const RETRY_MS = 2000

export class ReadObserver {
  /** Returns false when the ids could not be sent, and have to be offered again. */
  private readonly onRead: (ids: string[]) => boolean
  private readonly observer: IntersectionObserver | null
  /** Watched element → its message id, and back. */
  private readonly ids = new Map<Element, string>()
  private readonly elements = new Map<string, Element>()
  /** Ids at least half on screen right now, whatever the window is doing. */
  private readonly visible = new Set<string>()
  /** Id → when its dwell started. Absent means it is not currently counting. */
  private readonly since = new Map<string, number>()
  /** Reported ids, so a message is never named twice by this instance. */
  private readonly done = new Set<string>()
  private pending = new Set<string>()
  private poll: number | undefined
  private flush: number | undefined
  private disposed = false

  constructor(onRead: (ids: string[]) => boolean) {
    this.onRead = onRead
    this.observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => this.onIntersect(entries), {
            threshold: [VISIBLE_RATIO],
          })
    // Losing focus is not a slow event to notice — a window switch has to stop
    // the clock at the moment it happens, not up to a poll later.
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('visibilitychange', this.onBlur)
    this.poll = window.setInterval(() => this.tick(), POLL_MS)
  }

  /**
   * Starts (or stops, with a null element) watching one message.
   *
   * Safe to call on every render with the same pair: re-watching an element
   * already being watched is ignored, so this works as a React ref callback.
   */
  watch(id: string, element: Element | null): void {
    if (element === null) {
      this.unwatch(id)
      return
    }
    if (this.disposed || this.done.has(id)) return
    if (this.elements.get(id) === element) return
    this.unwatch(id)
    this.elements.set(id, element)
    this.ids.set(element, id)
    if (this.observer) {
      this.observer.observe(element)
    } else {
      // No IntersectionObserver — an old browser, or a test environment. Falling
      // back to "watched means visible" keeps receipts working; the dwell and
      // the focus check still apply, so it is a weaker rule, not no rule.
      this.visible.add(id)
    }
  }

  /** Stops watching one message, whatever state it is in. */
  private unwatch(id: string): void {
    const element = this.elements.get(id)
    if (element) {
      this.observer?.unobserve(element)
      this.ids.delete(element)
    }
    this.elements.delete(id)
    this.visible.delete(id)
    this.since.delete(id)
  }

  /**
   * Reports one message read right now, skipping every rule above.
   *
   * For the content a thumbnail does not show: a video, an audio message, a
   * file. Scrolling past a poster frame is not watching a video, so those
   * bubbles are never watched — they are reported from the player's own "this
   * started playing", which is a person having decided to open it. An image is
   * not in this list on purpose: the thumbnail *is* the image.
   */
  report(id: string): void {
    if (this.disposed || this.done.has(id)) return
    this.unwatch(id)
    this.done.add(id)
    this.pending.add(id)
    this.scheduleFlush()
  }

  dispose(): void {
    this.disposed = true
    this.observer?.disconnect()
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('visibilitychange', this.onBlur)
    window.clearInterval(this.poll)
    window.clearTimeout(this.flush)
    // Whatever had already earned its dwell is still read. Leaving on a thread
    // is not un-reading what was on screen a moment ago, and dropping it here
    // would mean a message read right before navigating away silently kept its
    // full seven days.
    this.send()
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const id = this.ids.get(entry.target)
      if (id === undefined) continue
      if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) {
        this.visible.add(id)
      } else {
        this.visible.delete(id)
        this.since.delete(id)
      }
    }
  }

  /** Focus lost: every dwell starts over when it comes back. */
  private readonly onBlur = (): void => {
    if (this.focused()) return
    this.since.clear()
  }

  private focused(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus()
  }

  private tick(): void {
    if (this.disposed) return
    if (!this.focused()) {
      this.since.clear()
      return
    }
    const now = Date.now()
    // Anything on screen without a dwell has just become eligible: a bubble
    // that scrolled in, or — the case a listener alone would miss — one that
    // was already on screen when the window lost focus. Its intersection never
    // changed, so nothing else would ever restart its clock.
    for (const id of this.visible) {
      if (!this.since.has(id)) this.since.set(id, now)
    }
    // Collected before acting: reporting one unwatches it, and that writes to
    // the map being walked.
    const ripe: string[] = []
    for (const [id, since] of this.since) {
      if (now - since >= DWELL_MS) ripe.push(id)
    }
    for (const id of ripe) {
      this.unwatch(id)
      this.done.add(id)
      this.pending.add(id)
    }
    if (this.pending.size > 0) this.scheduleFlush()
  }

  private scheduleFlush(delay = FLUSH_MS): void {
    if (this.flush !== undefined || this.disposed) return
    this.flush = window.setTimeout(() => this.send(), delay)
  }

  private send(): void {
    window.clearTimeout(this.flush)
    this.flush = undefined
    if (this.pending.size === 0) return
    const ids = [...this.pending]
    this.pending = new Set()
    if (this.onRead(ids)) return
    // Refused — the socket is not up. Back in the queue, and the ids stay in
    // `done` either way: they have been read, and what is outstanding is
    // telling the server so, not deciding it again.
    for (const id of ids) this.pending.add(id)
    this.scheduleFlush(RETRY_MS)
  }
}
