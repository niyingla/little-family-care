/* 仅用于本机预览：执行真实页面控制器，翻译WXML。并非微信运行时或真机验证。 */
const definitions = window.CARE_PREVIEW;
const modules = {};
function normalize(path) {
  const parts = [];
  path.split('/').forEach((p) => {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  });
  return parts.join('/');
}
function load(path) {
  if (modules[path]) return modules[path].exports;
  if (!definitions.scripts[path]) throw new Error(`预览模块缺失：${path}`);
  const module = { exports: {} };
  modules[path] = module;
  const require = (name) => {
    let resolved = normalize(path.slice(0, path.lastIndexOf('/') + 1) + name);
    if (!resolved.endsWith('.js')) resolved += '.js';
    if (resolved.endsWith('config.local.js')) throw new Error('预览不加载真实云配置');
    return load(resolved);
  };
  new Function('require', 'module', 'exports', definitions.scripts[path])(
    require,
    module,
    module.exports
  );
  return module.exports;
}
const templates = {};
function parseWxml(text) {
  // DOMParser的HTML模式不能理解WXML自闭合标签；先转换为非空的自定义标签。
  const tags =
    /<(\/?)(view|text|block|scroll-view|image|input|button|picker|template|import)(?=[\s/>])/g;
  text = text.replace(tags, '<$1care-$2').replace(/<(care-[\w-]+)([^>]*?)\s*\/>/g, '<$1$2></$1>');
  return new DOMParser().parseFromString(text, 'text/html').body;
}
for (const [path, source] of Object.entries(definitions.templates)) {
  const root = parseWxml(source);
  root.querySelectorAll('care-template[name]').forEach((node) => {
    templates[node.getAttribute('name')] = node;
  });
  if (path.endsWith('/index.wxml')) templates.root = root;
}
const expr = (code, scope) => {
  try {
    return new Function('scope', `with(scope){return (${code})}`)(scope);
  } catch (_) {
    return undefined;
  }
};
const value = (text, scope) => {
  if (text === null) return '';
  const match = text.match(/^{{([\s\S]*)}}$/);
  if (match) return expr(match[1], scope);
  return text.replace(/{{([\s\S]*?)}}/g, (_, code) => String(expr(code, scope) ?? ''));
};
const toast = (message) => {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
};
window.wx = {
  getStorageSync: (key) => {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (_) {
      return null;
    }
  },
  setStorageSync: (key, val) => localStorage.setItem(key, JSON.stringify(val)),
  showToast: (arg) => toast(arg.title),
  showModal: async (arg) => {
    const confirm =
      arg.showCancel === false
        ? (alert(`${arg.title}\n\n${arg.content}`), true)
        : window.confirm(`${arg.title}\n\n${arg.content}`);
    return { confirm };
  },
  setClipboardData: async (arg) => {
    await navigator.clipboard.writeText(arg.data);
    toast('已复制');
  },
  stopPullDownRefresh: () => {},
  chooseMedia: () =>
    new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) {
          reject({ errMsg: 'cancel' });
          return;
        }
        const tempFilePath = await new Promise((done) => {
          const reader = new FileReader();
          reader.onload = () => done(reader.result);
          reader.readAsDataURL(file);
        });
        resolve({ tempFiles: [{ tempFilePath, size: file.size }] });
      };
      input.oncancel = () => reject({ errMsg: 'cancel' });
      input.click();
    }),
  getFileSystemManager: () => ({
    saveFile: (arg) => arg.success({ savedFilePath: arg.tempFilePath }),
  }),
};
let page;
window.Page = (options) => {
  page = options;
  page.setData = (update) => {
    for (const [path, val] of Object.entries(update)) {
      const parts = path.split('.');
      let target = page.data;
      parts.slice(0, -1).forEach((p) => {
        target = target[p];
      });
      target[parts.at(-1)] = val;
    }
    render();
  };
  window.previewPage = page;
};
function children(parent, scope) {
  const fragment = document.createDocumentFragment();
  let inChain = false,
    selected = false;
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      if (node.textContent.trim())
        fragment.append(document.createTextNode(value(node.textContent, scope)));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const condition = node.getAttribute('wx:if'),
      elif = node.getAttribute('wx:elif'),
      otherwise = node.hasAttribute('wx:else');
    if (condition !== null) {
      inChain = true;
      selected = !!value(condition, scope);
      if (!selected) continue;
    } else if (elif !== null || otherwise) {
      if (!inChain || selected) continue;
      selected = otherwise || !!value(elif, scope);
      if (!selected) continue;
    } else {
      inChain = false;
      selected = false;
    }
    const loop = node.getAttribute('wx:for');
    if (loop !== null) {
      const values = value(loop, scope) || [];
      values.forEach((item, index) => fragment.append(element(node, { ...scope, item, index })));
    } else fragment.append(element(node, scope));
  }
  return fragment;
}
function element(node, scope) {
  const tag = node.tagName.toLowerCase().replace('care-', '');
  if (tag === 'import') return document.createDocumentFragment();
  if (tag === 'template') {
    const template = templates[node.getAttribute('is')];
    return template ? children(template, scope) : document.createDocumentFragment();
  }
  if (tag === 'block') return children(node, scope);
  if (tag === 'picker') {
    const mode = node.getAttribute('mode'),
      select = document.createElement(mode === 'date' || mode === 'time' ? 'input' : 'select');
    select.className = 'picker-input';
    if (mode === 'date' || mode === 'time') {
      select.type = mode;
      select.value = value(node.getAttribute('value'), scope) || '';
      select.min = value(node.getAttribute('start'), scope) || '';
      select.max = value(node.getAttribute('end'), scope) || '';
    } else {
      const range = value(node.getAttribute('range'), scope) || [];
      range.forEach((item, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = item[node.getAttribute('range-key')];
        select.append(option);
      });
      select.value = value(node.getAttribute('value'), scope) || 0;
    }
    bind(node, select, scope, 'change', 'bindchange');
    return select;
  }
  const el = document.createElement(
    tag === 'image'
      ? 'img'
      : tag === 'input'
        ? 'input'
        : tag === 'button'
          ? 'button'
          : tag === 'text'
            ? 'span'
            : 'div'
  );
  for (const attr of node.attributes) {
    if (
      attr.name.startsWith('wx:') ||
      attr.name.startsWith('bind') ||
      attr.name.startsWith('catch') ||
      ['open-type', 'mode', 'scroll-x', 'scroll-y'].includes(attr.name)
    )
      continue;
    const val = value(attr.value, scope);
    if (attr.name === 'disabled') el.disabled = !!val;
    else if (attr.name === 'value') el.value = val || '';
    else if (attr.name === 'type' && val === 'number') el.type = 'number';
    else el.setAttribute(attr.name, val ?? '');
  }
  if (tag !== 'image' && tag !== 'input') el.append(children(node, scope));
  bind(node, el, scope, 'click', 'bindtap');
  bind(node, el, scope, 'click', 'catchtap', true);
  bind(node, el, scope, 'input', 'bindinput');
  if (node.getAttribute('open-type') === 'share')
    el.addEventListener('click', () => toast('浏览器预览不能发微信，请在微信中使用分享卡片'));
  return el;
}
function bind(node, el, scope, event, attribute, stop = false) {
  const handler = node.getAttribute(attribute);
  if (!handler) return;
  el.addEventListener(event, async (e) => {
    if (stop) e.stopPropagation();
    const dataset = {};
    for (const attr of node.attributes)
      if (attr.name.startsWith('data-')) dataset[attr.name.slice(5)] = value(attr.value, scope);
    await page[handler]({
      currentTarget: { dataset },
      target: { dataset },
      detail: { value: e.target.value },
    });
  });
}
function render() {
  // 输入过程中保留光标和焦点，让预览复用真实控制器时仍可连续编辑。
  const focus = document.activeElement,
    field = focus?.getAttribute('data-field'),
    position = focus?.selectionStart;
  document.getElementById('app').replaceChildren(children(templates.root, page.data));
  if (field) {
    const next = [...document.querySelectorAll('[data-field]')].find(
      (n) => n.getAttribute('data-field') === field && n.tagName === focus.tagName
    );
    if (next) {
      next.focus();
      try {
        next.setSelectionRange(position, position);
      } catch (_) {}
    }
  }
}
const style = definitions.style
  .replace(/([\d.]+)rpx/g, (_, n) => `${(Number(n) * Math.min(innerWidth, 430)) / 750}px`)
  .replace(/(^|\n)page\s*\{/g, '$1#app{');
document.getElementById('native-style').textContent = style;
load('miniprogram/pages/index/index.js');
Promise.resolve(page.onLoad({}))
  .then(() => page.startDemo())
  .then(() => {
    page.onShow();
    window.previewReady = true;
  });
