import app from "./app.js";
import { APP_ORIGIN, PORT } from "./shared/config.js";
import { storeBackend } from "./shared/store.js";

app.listen(PORT, () => {
  console.log(`OAuth Flow Lab on ${APP_ORIGIN}  (store: ${storeBackend})`);
  console.log(`  Client App  ${APP_ORIGIN}/client`);
  console.log(`  Inspector   ${APP_ORIGIN}/inspector`);
});
