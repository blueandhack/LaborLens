import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import App from './App.jsx';

// Build-time rendering uses the real public UI. Data queries still run on the
// client, so the release does not freeze case counts or require database access.
export function render(path) {
  return renderToString(<App RouterComponent={StaticRouter} routerProps={{ location: path }} />);
}
