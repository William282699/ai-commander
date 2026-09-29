// 试玩记录仪：第一个执行——把地址栏里的邀请存进本地并当场抹掉，再加载其余一切。
import "./recorder/boot";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/game-ui.css";
import App from "./App";
import { RecorderGate } from "./recorder/RecorderGate";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RecorderGate>
      <App />
    </RecorderGate>
  </React.StrictMode>,
);
