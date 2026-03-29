import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import log from "@slackgram/logger";

log.info("Starting frontend");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

