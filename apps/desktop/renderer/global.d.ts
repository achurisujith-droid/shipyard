import type { ShipyardApi } from '@shipyard/shared';

declare global {
  interface Window {
    /** Exposed by preload/index.ts. The renderer's only route out. */
    shipyard: ShipyardApi;
  }

  namespace JSX {
    interface IntrinsicElements {
      /**
       * Electron's <webview>, used by the preview pane to render the user's own
       * dev server. Not part of React's DOM types, so it is declared here.
       */
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        webpreferences?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}

export {};
