import { useEffect } from 'react';

/**
 * Makes the phone's back gesture close a full-screen panel instead of leaving the app.
 *
 * A sheet that covers the whole screen reads as a page, and a phone user's instinct for a
 * page is to swipe back. Without this the swipe unloads the app and the search that
 * produced the sheet goes with it -- which, mid-bulletin, is the difference between a
 * one-tap correction and starting over.
 *
 * The mechanism is one pushed history entry per open sheet, popped again on close. Closing
 * by the button and closing by the gesture therefore leave the history in the same state,
 * which is what stops a session of open-close-open from building a stack of dead entries.
 */
interface SheetState {
  sheet?: boolean;
}

export function useBackToClose(onClose: () => void): void {
  useEffect(() => {
    history.pushState({ sheet: true } satisfies SheetState, '');

    const onPop = (): void => onClose();
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      // Only unwind our own entry. If a back gesture is what closed the sheet, the entry is
      // already gone and calling back() again would leave the app.
      if ((history.state as SheetState | null)?.sheet) history.back();
    };
  }, [onClose]);
}
