import { useCallback, useState } from 'react';

import type { AuthStatus, DetectResult, SessionHandle } from '@shipyard/shared';

import { ChatScreen } from './screens/ChatScreen';
import { ClaudeCheckScreen } from './screens/ClaudeCheckScreen';
import { HomeScreen } from './screens/HomeScreen';
import { PlanCheckScreen } from './screens/PlanCheckScreen';
import { IntakeScreen } from './screens/IntakeScreen';
import { ConnectorsScreen } from './screens/ConnectorsScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { WelcomeScreen } from './screens/WelcomeScreen';

type Screen = 'welcome' | 'claude-check' | 'plan-check' | 'home' | 'new' | 'chat' | 'library' | 'connectors';

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [session, setSession] = useState<SessionHandle | null>(null);
  /** Composed by the intake wizard, pre-filled in the composer, never auto-sent. */
  const [prefill, setPrefill] = useState<string | undefined>(undefined);

  const onClaudeReady = useCallback((d: DetectResult, a: AuthStatus) => {
    setDetect(d);
    setAuth(a);
    setScreen('plan-check');
  }, []);

  const openSession = useCallback((handle: SessionHandle, firstMessage?: string) => {
    setSession(handle);
    setPrefill(firstMessage);
    setScreen('chat');
  }, []);

  switch (screen) {
    case 'welcome':
      return <WelcomeScreen onContinue={() => setScreen('claude-check')} />;

    case 'claude-check':
      return <ClaudeCheckScreen onReady={onClaudeReady} />;

    case 'plan-check':
      return (
        <PlanCheckScreen
          auth={auth}
          detect={detect}
          onContinue={() => setScreen('home')}
          onBack={() => setScreen('claude-check')}
        />
      );

    case 'home':
      return <HomeScreen onOpened={openSession} onNew={() => setScreen('new')} />;

    case 'new':
      return (
        <IntakeScreen
          onStarted={openSession}
          onCancel={() => setScreen('home')}
        />
      );

    case 'chat':
      // Home is the fallback rather than the new-project form: landing on a
      // blank "name your app" after losing a session would look like the work
      // was thrown away.
      return session ? (
        <ChatScreen
          session={session}
          prefill={prefill}
          onExit={() => setScreen('home')}
          onOpenLibrary={() => setScreen('library')}
          onOpenConnectors={() => setScreen('connectors')}
        />
      ) : (
        <HomeScreen onOpened={openSession} onNew={() => setScreen('new')} />
      );

    case 'connectors':
      return session ? (
        <ConnectorsScreen projectPath={session.cwd} onBack={() => setScreen('chat')} />
      ) : (
        <HomeScreen onOpened={openSession} onNew={() => setScreen('new')} />
      );

    case 'library':
      // Only reachable with a session open, because a component is installed
      // into a particular project rather than in the abstract.
      return session ? (
        <LibraryScreen projectPath={session.cwd} onBack={() => setScreen('chat')} />
      ) : (
        <HomeScreen onOpened={openSession} onNew={() => setScreen('new')} />
      );

    default:
      return <WelcomeScreen onContinue={() => setScreen('claude-check')} />;
  }
}
