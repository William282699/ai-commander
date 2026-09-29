// ============================================================
// 试玩记录仪 · 最小管理员页（列表 / 查看时间线 / 下载单局 ZIP / 生成与作废邀请）
//
// 页面本身不带数据。管理员凭证只存在这一页的内存里（刷新即需重输），
// 只走 Authorization 头。所有来自玩家/模型的文字一律用 textContent 放进页面，
// 查看时间线用无脚本沙箱 iframe（srcdoc）。
// ============================================================

export const ADMIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>试玩记录 · 管理</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#f7f7f5;color:#1d1d1f}
h1{font-size:19px;margin:0 0 12px}h2{font-size:16px;margin:20px 0 8px}
input,button{font:inherit;padding:4px 10px}button{cursor:pointer}
table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
.muted{color:#6e6e73;font-size:12px}.ok{color:#1a7f37}.gap{color:#b35900}.unk{color:#6e6e73}.err{color:#b00020}
#view{width:100%;height:70vh;border:1px solid #ccc;background:#fff;margin-top:8px}
.box{background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin:8px 0}
code{word-break:break-all}
</style></head><body>
<h1>试玩记录 · 管理</h1>
<div class="box" id="login">
  <label>管理员凭证 <input id="tok" type="password" autocomplete="off" size="40"></label>
  <button id="go">进入</button>
  <div class="muted">凭证只留在这个页面的内存里，刷新后需要重新输入。</div>
</div>
<div id="main" hidden>
  <div class="box"><span id="usage" class="muted"></span> <button id="refresh">刷新</button> <span id="msg" class="err"></span></div>
  <h2>邀请</h2>
  <div class="box">
    <button id="newInvite">生成一个邀请</button>
    <div id="newInviteOut"></div>
    <table id="invites"><thead><tr><th>测试者</th><th>生成时间</th><th>状态</th><th>局数</th><th></th></tr></thead><tbody></tbody></table>
  </div>
  <h2>各局记录</h2>
  <table id="runs"><thead><tr><th>测试者</th><th>第几局</th><th>场景</th><th>开局</th><th>游戏时长</th><th>结束</th><th>问题标记</th><th>记录状态</th><th></th></tr></thead><tbody></tbody></table>
  <h2 id="viewTitle" hidden>时间线</h2>
  <iframe id="view" hidden sandbox="" title="时间线"></iframe>
</div>
<script src="/rec-admin/app.js"></script>
</body></html>`;

export const ADMIN_PAGE_JS = `(function(){
  "use strict";
  var token = "";
  var $ = function(id){ return document.getElementById(id); };
  function el(tag, text, cls){ var e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (cls) e.className = cls; return e; }
  function api(path, opts){
    opts = opts || {};
    var headers = { "Authorization": "Bearer " + token };
    return fetch(path, { method: opts.method || "GET", headers: headers, cache: "no-store" }).then(function(r){
      if (r.status === 401) throw new Error("凭证不对");
      if (!r.ok) throw new Error("服务器返回 " + r.status);
      return opts.raw ? r : r.json();
    });
  }
  function scen(s){ return ({ el_alamein: "阿拉曼", tutorial: "教学关", dual_island: "双岛" })[s] || s; }
  function dur(sec){ sec = Math.round(sec || 0); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
  function when(ms){ if (!ms) return "—"; var d = new Date(ms); return d.toLocaleString(); }
  function showErr(e){ $("msg").textContent = e && e.message ? e.message : String(e); }
  function load(){
    $("msg").textContent = "";
    api("/api/rec/admin/runs").then(function(j){
      var u = j.usage || {};
      $("usage").textContent = "已用 " + ((u.totalBytes || 0) / 1048576).toFixed(1) + " MiB / " + ((u.globalMaxBytes || 0) / 1048576).toFixed(0) + " MiB，共 " + (u.runs || 0) + " 局；采集" + (j.collect ? "开启" : "关闭") + (u.lastWriteError ? "；最近一次写盘失败 " + u.lastWriteError.code : "");
      var tb = $("runs").querySelector("tbody"); tb.textContent = "";
      (j.runs || []).forEach(function(r){
        var tr = document.createElement("tr");
        tr.appendChild(el("td", "测试者 " + r.tid));
        tr.appendChild(el("td", "第 " + r.index + " 局"));
        tr.appendChild(el("td", scen(r.scenario)));
        tr.appendChild(el("td", when(r.firstAt)));
        tr.appendChild(el("td", dur(r.gameSec)));
        tr.appendChild(el("td", r.end));
        tr.appendChild(el("td", r.flags + " 处"));
        var st = el("td", r.completeness.label, r.completeness.status === "complete" ? "ok" : r.completeness.status === "known_gaps" ? "gap" : "unk");
        st.title = (r.completeness.reasons || []).join("\\n");
        tr.appendChild(st);
        var act = document.createElement("td");
        var v = el("button", "查看"); v.onclick = function(){ view(r); };
        var dl = el("button", "下载 ZIP"); dl.onclick = function(){ download(r); };
        act.appendChild(v); act.appendChild(document.createTextNode(" ")); act.appendChild(dl);
        tr.appendChild(act);
        tb.appendChild(tr);
      });
    }).catch(showErr);
    api("/api/rec/admin/invites").then(function(j){
      var tb = $("invites").querySelector("tbody"); tb.textContent = "";
      (j.invites || []).forEach(function(i){
        var tr = document.createElement("tr");
        tr.appendChild(el("td", "测试者 " + i.tid));
        tr.appendChild(el("td", when(i.createdAt)));
        tr.appendChild(el("td", i.revokedAt ? "已作废（" + when(i.revokedAt) + "）" : "有效"));
        tr.appendChild(el("td", i.runs));
        var act = document.createElement("td");
        if (!i.revokedAt) {
          var b = el("button", "作废");
          b.onclick = function(){ if (!confirm("作废测试者 " + i.tid + " 的邀请？之后他的浏览器会停止记录并清掉未上传的缓存；已存档的记录不动。")) return; api("/api/rec/admin/invites/" + encodeURIComponent(i.tid) + "/revoke", { method: "POST" }).then(load).catch(showErr); };
          act.appendChild(b);
        }
        tr.appendChild(act);
        tb.appendChild(tr);
      });
    }).catch(showErr);
  }
  function view(r){
    api("/api/rec/admin/runs/" + encodeURIComponent(r.runId) + "/report", { raw: true }).then(function(res){ return res.text(); }).then(function(html){
      $("viewTitle").hidden = false; $("viewTitle").textContent = "时间线 · 测试者 " + r.tid + " 第 " + r.index + " 局";
      var f = $("view"); f.hidden = false; f.srcdoc = html; f.scrollIntoView();
    }).catch(showErr);
  }
  function download(r){
    api("/api/rec/admin/runs/" + encodeURIComponent(r.runId) + "/zip", { raw: true }).then(function(res){
      var cd = res.headers.get("Content-Disposition") || ""; var m = /filename="([^"]+)"/.exec(cd);
      return res.blob().then(function(b){ return { b: b, name: m ? m[1] : "playtest.zip" }; });
    }).then(function(x){
      var a = document.createElement("a"); a.href = URL.createObjectURL(x.b); a.download = x.name; document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }).catch(showErr);
  }
  $("go").onclick = function(){ token = $("tok").value.trim(); $("tok").value = ""; api("/api/rec/admin/runs").then(function(){ $("login").hidden = true; $("main").hidden = false; load(); }).catch(showErr); };
  $("refresh").onclick = load;
  $("newInvite").onclick = function(){
    api("/api/rec/admin/invites", { method: "POST" }).then(function(j){
      var out = $("newInviteOut"); out.textContent = "";
      var link = location.origin + "/?invite=" + encodeURIComponent(j.token);
      out.appendChild(el("div", "测试者 " + j.tid + " 的邀请链接（只显示这一次，请复制后发给他）："));
      var c = el("code", link); out.appendChild(c);
      load();
    }).catch(showErr);
  };
})();`;
