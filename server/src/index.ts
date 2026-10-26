import { loadConfig } from "./config.js";
import { startServer } from "./ws.js";

const config = loadConfig();
startServer(config);
