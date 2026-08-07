const DURATION = 8_000;
const stage = document.querySelector(".stage");
const curtain = document.querySelector(".curtain");
const curtainCopy = document.querySelector(".curtain-copy");
const denseWall = document.querySelector(".dense-wall");
const nineGrid = document.querySelector(".nine-grid");
const heroImage = document.querySelector(".hero img");
let ready = false;
let finishTimer = 0;

boot().catch(error => {
  curtainCopy.innerHTML = `<strong>素材加载失败</strong><span>${escapeHtml(error.message)}</span>`;
});

async function boot() {
  const manifest = await fetch("../assets/manifest.json", { cache: "no-store" }).then(response => {
    if (!response.ok) throw new Error("请先运行 npm run promo:prepare");
    return response.json();
  });
  const images = manifest.screenshots || [];
  if (images.length < 90) throw new Error("截图不足，请重新准备素材");
  await preload(images.map(item => item.src), progress => {
    curtainCopy.innerHTML = `<strong>正在准备截图</strong><span>${progress} / ${images.length}</span>`;
  });
  render(images);
  ready = true;
  curtain.classList.add("ready");
  curtainCopy.innerHTML = "<strong>准备完成</strong><span>按 F 全屏 · 按空格播放</span>";
  showPreviewFrameFromUrl();
}

function showPreviewFrameFromUrl() {
  const frame = Number(new URLSearchParams(location.search).get("frame"));
  if (!Number.isFinite(frame) || frame < 0) return;
  curtain.hidden = true;
  document.body.classList.add("playing");
  void stage.offsetWidth;
  requestAnimationFrame(() => {
    document.getAnimations().forEach(animation => {
      animation.currentTime = Math.min(frame, DURATION);
      animation.pause();
    });
  });
}

function render(images) {
  heroImage.src = images[0].src;
  nineGrid.replaceChildren(...images.slice(0, 9).map(createImage));
  const columns = Array.from({ length: 10 }, (_, columnIndex) => {
    const column = document.createElement("div");
    column.className = "image-column";
    column.style.setProperty("--start-y", `${-2 - (columnIndex % 3) * 2}%`);
    column.style.setProperty("--end-y", `${-10 - (columnIndex % 4) * 2}%`);
    const columnImages = images.filter((_, index) => index % 10 === columnIndex);
    column.replaceChildren(...columnImages.map(item => {
      const card = document.createElement("div");
      card.className = "image-card";
      card.append(createImage(item));
      return card;
    }));
    return column;
  });
  denseWall.replaceChildren(...columns);
}

function createImage(item) {
  const image = new Image();
  image.src = item.src;
  image.alt = "";
  image.draggable = false;
  return image;
}

function play() {
  if (!ready) return;
  clearTimeout(finishTimer);
  document.body.classList.remove("playing", "finished");
  void stage.offsetWidth;
  curtain.hidden = true;
  document.body.classList.add("playing");
  finishTimer = window.setTimeout(() => {
    document.body.classList.remove("playing");
    document.body.classList.add("finished");
  }, DURATION);
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  else await document.exitFullscreen();
}

document.addEventListener("keydown", event => {
  if (event.code === "Space") {
    event.preventDefault();
    play();
  }
  if (event.key.toLowerCase() === "f") toggleFullscreen().catch(() => {});
});
curtain.addEventListener("click", play);

async function preload(urls, onProgress) {
  let complete = 0;
  await Promise.all(urls.map(url => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { complete += 1; onProgress(complete); resolve(); };
    image.onerror = () => reject(new Error(`无法加载 ${url}`));
    image.src = url;
  })));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
