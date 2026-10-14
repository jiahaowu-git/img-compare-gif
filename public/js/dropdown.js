/**
 * dropdown.js —— 把原生 <select> 换肤成与页面风格一致的自绘下拉框
 *
 * 原生 select 展开后的列表由操作系统绘制，无法用 CSS 美化，样式与整站完全不搭。
 * 这里的做法是"渐进增强"：
 *   - 保留原生 <select>（改为 display:none）作为数据源，原有 JS 读 .value、
 *     监听 change 事件的逻辑一行都不用改；
 *   - 用 button[role=combobox] + div[role=listbox] 自绘触发器与选项列表；
 *   - 选中后同步 select.value 并派发冒泡的 change 事件。
 * 同时支持键盘（↑↓ 移动、Enter/Space 选中、Esc 关闭）、点击外部关闭、
 * 空间不足时自动向上弹出，以及随页面滚动的自动收起。
 */
(function (root) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function createChevron(cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', cls);
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2.2 4.4 6 8.2l3.8-3.8');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function enhance(select) {
    if (!select || select.dataset.enhanced) return null;
    select.dataset.enhanced = '1';

    var options = Array.prototype.map.call(select.options, function (o) {
      return { value: o.value, label: (o.textContent || '').trim() };
    });
    if (!options.length) return null;

    var index = select.selectedIndex >= 0 ? select.selectedIndex : 0;
    var active = index;
    var isOpen = false;

    /* --------------------------------------------------- 结构 */
    var wrap = document.createElement('div');
    wrap.className = 'select';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.id = (select.id || 'select') + '-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var label = document.createElement('span');
    label.className = 'select-label';
    trigger.appendChild(label);
    trigger.appendChild(createChevron('select-chevron'));

    var menu = document.createElement('div');
    menu.className = 'select-menu';
    menu.id = (select.id || 'select') + '-menu';
    menu.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', menu.id);

    var items = options.map(function (opt, i) {
      var item = document.createElement('div');
      item.className = 'select-option';
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;

      var text = document.createElement('span');
      text.className = 'select-option-text';
      text.textContent = opt.label;
      item.appendChild(text);
      item.appendChild(createChevron('select-tick'));

      item.addEventListener('mouseenter', function () { setActive(i); });
      item.addEventListener('mousedown', function (e) { e.preventDefault(); });
      item.addEventListener('click', function (e) { e.preventDefault(); choose(i); });
      menu.appendChild(item);
      return item;
    });

    // 插到原生 select 的位置上，并把它隐藏（保留 .value 与 change 语义）
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    select.classList.add('select-native');

    var fieldLabel = document.querySelector('label[for="' + select.id + '"]');
    if (fieldLabel) fieldLabel.setAttribute('for', trigger.id);

    /* --------------------------------------------------- 状态同步 */
    function sync() {
      label.textContent = options[index].label;
      for (var i = 0; i < items.length; i++) {
        var on = i === index;
        items[i].classList.toggle('selected', on);
        items[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }

    function setActive(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      for (var k = 0; k < items.length; k++) items[k].classList.toggle('active', k === active);
    }

    function scrollActiveIntoView() {
      var el = items[active];
      if (!el) return;
      var top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top - 6;
      else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight + 6;
    }

    function choose(i) {
      index = i;
      select.value = options[i].value;
      sync();
      close();
      trigger.focus();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /* --------------------------------------------------- 开关 */
    function onDocPointer(e) {
      if (!wrap.contains(e.target)) close();
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      wrap.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      setActive(index);
      // 下方空间不足且上方更宽裕时向上弹出
      var rect = trigger.getBoundingClientRect();
      var below = window.innerHeight - rect.bottom;
      var need = Math.min(menu.offsetHeight || 220, 240) + 14;
      wrap.classList.toggle('menu-up', below < need && rect.top > below);
      var card = select.closest('.card');
      if (card) card.classList.add('dropdown-open');     // 抬高层级，避免被下一张卡片盖住
      document.addEventListener('pointerdown', onDocPointer, true);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', close, true);
      scrollActiveIntoView();
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      wrap.classList.remove('open', 'menu-up');
      trigger.setAttribute('aria-expanded', 'false');
      var card = select.closest('.card');
      if (card) card.classList.remove('dropdown-open');
      document.removeEventListener('pointerdown', onDocPointer, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    }

    trigger.addEventListener('click', function () {
      if (isOpen) close(); else open();
    });

    trigger.addEventListener('keydown', function (e) {
      switch (e.key) {
        case 'Escape':
          if (isOpen) { e.preventDefault(); close(); }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) open();
          else { setActive(active + 1); scrollActiveIntoView(); }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!isOpen) open();
          else { setActive(active - 1); scrollActiveIntoView(); }
          break;
        case 'Home':
          if (isOpen) { e.preventDefault(); setActive(0); scrollActiveIntoView(); }
          break;
        case 'End':
          if (isOpen) { e.preventDefault(); setActive(items.length - 1); scrollActiveIntoView(); }
          break;
        case 'Enter':
        case ' ':
          if (isOpen) { e.preventDefault(); choose(active); }
          break;
        default:
          break;
      }
    });

    sync();
    return { open: open, close: close, select: select };
  }

  function enhanceAll(selector, rootEl) {
    var scope = rootEl || document;
    return Array.prototype.map.call(scope.querySelectorAll(selector || 'select'), enhance).filter(Boolean);
  }

  var api = { enhance: enhance, enhanceAll: enhanceAll };
  root.Dropdown = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
