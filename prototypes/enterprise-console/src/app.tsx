import { ConsoleProvider, useConsole } from './console';
import { AdminPages } from './pages/admin';
import { UserPages } from './pages/user';
import { Shell } from './shell';

function Frame() {
  const { role, pathname } = useConsole();
  return (
    <Shell>
      {role === 'user' || role === 'dept' ? (
        <UserPages pathname={pathname} />
      ) : (
        <AdminPages pathname={pathname} />
      )}
    </Shell>
  );
}

export function App() {
  return (
    <ConsoleProvider>
      <Frame />
    </ConsoleProvider>
  );
}
