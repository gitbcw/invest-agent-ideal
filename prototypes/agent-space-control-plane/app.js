const data = await fetch("/fixture.json", { cache: "no-store" }).then((response) => response.json());
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const status = (value) => `<span class="pill ${value}">${esc(value.replaceAll("_", " "))}</span>`;

$("#scope").textContent = data.metadata.scope;
$("#agent-heading").textContent = data.agent.name;
$("#agent-description").textContent = data.agent.description;
$("#agent-id").textContent = data.agent.id;
$("#agent-status").textContent = data.agent.status;
$("#generated-at").textContent = `夹具生成于 ${new Date(data.metadata.generatedAt).toLocaleString("zh-CN", { hour12: false })}`;
$("#stats").innerHTML = [
  ["已采用方法", data.methods.filter((item) => item.status === "adopted").length],
  ["活跃任务", data.tasks.filter((item) => item.status === "active").length],
  ["运行依据", data.runs.length],
  ["已安装 Skill", data.skills.filter((item) => item.status !== "empty").length]
].map(([label, value]) => `<article class="stat"><strong>${value}</strong><span>${label}</span></article>`).join("");
$("#skills").innerHTML = data.skills.map((skill) => `<div class="skill-row"><div><strong>${esc(skill.name)}</strong><p>${esc(skill.note)}</p></div>${status(skill.status)}</div>`).join("");
$("#method-list").innerHTML = data.methods.map((method) => `<article class="row-card"><div><div class="row-title"><h3>${esc(method.name)}</h3>${status(method.status)}</div><p>${esc(method.note)}</p><code>${esc(method.versionId)} · ${esc(method.checksum)}</code></div><div class="version">${esc(method.version)}</div></article>`).join("");
$("#task-list").innerHTML = data.tasks.map((task) => `<article class="row-card"><div><div class="row-title"><h3>${esc(task.name)}</h3>${status(task.status)}</div><p>${task.dependencies.length ? "固定依赖" : esc(task.emptyReason)}</p><div class="chips">${task.dependencies.map((dependency) => `<span>${esc(dependency.kind)} · ${esc(dependency.name)} · ${esc(dependency.version)} · ${esc(dependency.policy)}</span>`).join("") || "<span>显式空集</span>"}</div></div><code>${esc(task.id)}</code></article>`).join("");

function showBasis(run) {
  const basis = run.basis;
  $("#basis-detail").innerHTML = `<p class="eyebrow">RUN BASIS</p><h3>${esc(run.taskName)}</h3><dl>
    <dt>入口</dt><dd>${esc(basis.entryKind)}</dd><dt>运行依据</dt><dd><code>${esc(basis.basisKey)}</code></dd>
    <dt>方法</dt><dd>${basis.methods.length ? basis.methods.map((item) => `${esc(item.name)} ${esc(item.version)} <small>${esc(item.origin)}</small>`).join("<br>") : "显式空集"}</dd>
    <dt>资产</dt><dd>${basis.assets.length ? basis.assets.map((item) => `${esc(item.name)} ${esc(item.version)} <small>${esc(item.role)}</small>`).join("<br>") : "无"}</dd>
    <dt>Skill</dt><dd>${basis.skills.length || "空安装集"}</dd>
    <dt>状态包</dt><dd>${basis.state.included}/${basis.state.scanned} · ${esc(basis.state.note)}</dd>
    <dt>实际注入</dt><dd>workspace = ${basis.injection.workspace === null ? "null" : "present"}<br>${basis.injection.tools.map(esc).join(" · ") || "无工具"}</dd>
    <dt>执行 / 投递</dt><dd>${status(basis.execution)} ${status(basis.delivery)}</dd>
  </dl>`;
}
$("#run-list").innerHTML = data.runs.map((run, index) => `<button class="run-card ${index === 0 ? "selected" : ""}" data-run="${esc(run.id)}"><span>${esc(run.taskName)}</span>${status(run.status)}<small>${new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false })}</small></button>`).join("");
$("#run-list").addEventListener("click", (event) => { const card = event.target.closest("[data-run]"); if (!card) return; document.querySelectorAll(".run-card").forEach((item) => item.classList.toggle("selected", item === card)); showBasis(data.runs.find((run) => run.id === card.dataset.run)); });
showBasis(data.runs[0]);
document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".tabs button, .view").forEach((item) => item.classList.remove("active")); button.classList.add("active"); $(`#${button.dataset.view}`).classList.add("active"); }));
