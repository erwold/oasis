import { memo, useDeferredValue, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type UIEventHandler } from 'react'

/** Only the first stored transcript render may yield; it commits whole, never a prefix or a placeholder. Once
 * anything has committed, all updates are immediate, including live → ended and replay → normal. The keyed
 * component owns both scroller and readiness: A → B → A and Records → Back each get a new opening, not A's old latch. */
export const DeferredTranscript = memo(function DeferredTranscript({ children, immediate, sessionId, scrollerRef, onScroll, onInitialFollow }: {
  children: ReactNode; immediate: boolean; sessionId: string; scrollerRef: Ref<HTMLDivElement>; onScroll: UIEventHandler<HTMLDivElement>; onInitialFollow: () => void
}) {
  const [committed, setCommitted] = useState(false)
  const rendered = useDeferredValue(committed || immediate ? null : children, null)
  const shown = committed || immediate ? children : rendered
  useLayoutEffect(() => {
    if (!committed && shown !== null) setCommitted(true)
  }, [committed, shown])
  const followed = useRef(false)
  useLayoutEffect(() => {
    // The latched commit uses the latest children, and the parent's session reset has already run. Do this once
    // before paint/lazy-image observation, not on the empty shell or on every later resize/update.
    if (committed && !followed.current) { followed.current = true; onInitialFollow() }
  }, [committed, onInitialFollow])
  return <div className="thread-scroll deferred-transcript" ref={scrollerRef} onScroll={onScroll} data-testid="thread" data-session-id={sessionId} data-transcript-pending={!committed || undefined}>{shown}</div>
})
