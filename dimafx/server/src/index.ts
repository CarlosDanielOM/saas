import { createServer } from './server.js';

const port = Number(process.env.PORT || 8080);
const app = createServer();

app.listen(port, () => {
  console.log(`DimaFX server listening on ${port}`);
});
