const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  ButtonComponent,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  skipSelf: true,
  showNoticeDetails: true,
  refreshAfterGroupAction: true,
  groups: [],
};

function normalizeClassList(input) {
  if (!input) return [];
  return (Array.isArray(input) ? input : String(input).split(/\s+/))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function applyButtonMeta(buttonEl, options = {}) {
  if (!buttonEl) return buttonEl;

  const { classes = [], tooltip = '', ariaLabel = '' } = options;
  for (const cls of normalizeClassList(classes)) {
    buttonEl.addClass?.(cls);
  }

  const label = ariaLabel || tooltip;
  if (tooltip) buttonEl.setAttribute('title', tooltip);
  if (label) buttonEl.setAttribute('aria-label', label);
  return buttonEl;
}

function decorateButtonComponent(button, options = {}) {
  applyButtonMeta(button?.buttonEl, options);
  return button;
}


class PluginGroupTogglePlugin extends Plugin {
  async onload() {
    this.registeredGroupCommandIds = [];

    try {
      await this.loadSettings();
      const groupsMigrated = this.normalizeGroups();
      if (groupsMigrated) {
        await this.saveSettings();
      }

      this.addCommand({
        id: 'open-plugin-selector',
        name: '弹出插件选择器',
        callback: () => new PluginSelectorModal(this.app, this).open(),
      });

      this.addCommand({
        id: 'disable-plugin-groups',
        name: '批量关闭场景',
        callback: () => {
          if (!this.getGroups().length) {
            new Notice('当前还没有插件场景');
            return;
          }
          new GroupMultiActionModal(this.app, this, 'disable').open();
        },
      });

      this.addCommand({
        id: 'enable-plugin-groups',
        name: '批量开启场景',
        callback: () => {
          if (!this.getGroups().length) {
            new Notice('当前还没有插件场景');
            return;
          }
          new GroupMultiActionModal(this.app, this, 'enable').open();
        },
      });

      this.addCommand({
        id: 'manage-saved-groups',
        name: '已保存场景管理',
        callback: () => {
          if (!this.getGroups().length) {
            new Notice('当前还没有插件场景');
            return;
          }
          this.openPluginSettingsTab();
        },
      });

      this.addRibbonIcon('boxes', '插件场景开关：弹出插件选择器', () => {
        new PluginSelectorModal(this.app, this).open();
      });

      this.addSettingTab(new PluginGroupToggleSettingTab(this.app, this));
      this.refreshGroupCommands();
    } catch (error) {
      console.error('[plugin-group-toggle] onload failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`插件加载失败：${message}`, 8000);
    }
  }

  onunload() {
    this.unregisterGroupCommands();
  }

  async loadSettings() {
    const data = await this.loadData();
    const persisted = data && typeof data === 'object' ? data : {};

    this.settings = Object.assign({}, DEFAULT_SETTINGS, persisted, {
      refreshAfterGroupAction:
        persisted.refreshAfterGroupAction ??
        persisted.autoRefreshAfterGroupAction ??
        DEFAULT_SETTINGS.refreshAfterGroupAction,
    });

    delete this.settings.autoRefreshAfterGroupAction;
    if (!Array.isArray(this.settings.groups)) this.settings.groups = [];
  }

  async saveSettings() {
    const persisted = Object.assign({}, this.settings);
    delete persisted.autoRefreshAfterGroupAction;
    await this.saveData(persisted);
  }

  openPluginSettingsTab() {
    try {
      if (typeof this.app.setting?.open === 'function') {
        this.app.setting.open();
      }
      if (typeof this.app.setting?.openTabById === 'function') {
        this.app.setting.openTabById(this.manifest.id);
        return true;
      }
    } catch (error) {
      console.error('[plugin-group-toggle] openPluginSettingsTab failed:', error);
    }

    new Notice('无法打开插件设置页，请手动进入本插件设置');
    return false;
  }

  getGroups() {
    return Array.isArray(this.settings.groups) ? this.settings.groups : [];
  }

  makeSceneId(seed) {
    const input = String(seed || 'scene');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `scene-${(hash >>> 0).toString(36)}`;
  }

  ensureUniqueSceneId(preferredId, name, usedIds) {
    const base = String(preferredId || '').trim() || this.makeSceneId(name);
    let candidate = base;
    let index = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  normalizeGroups() {
    const before = JSON.stringify(this.getGroups());
    const map = new Map();
    const usedIds = new Set();

    for (const rawGroup of this.getGroups()) {
      const name = String(rawGroup?.name || '').trim();
      const pluginIds = Array.from(
        new Set((rawGroup?.pluginIds || []).map((id) => String(id).trim()).filter(Boolean))
      );

      if (!name || !pluginIds.length) continue;

      const existing = map.get(name);
      if (existing) {
        existing.pluginIds = Array.from(new Set([...existing.pluginIds, ...pluginIds]));
        continue;
      }

      const sceneId = this.ensureUniqueSceneId(rawGroup?.sceneId, name, usedIds);
      map.set(name, { sceneId, name, pluginIds });
    }

    this.settings.groups = Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN')
    );

    return before !== JSON.stringify(this.settings.groups);
  }

  getGroupByName(name) {
    return this.getGroups().find((group) => group.name === name) || null;
  }

  getInstalledCommunityPlugins() {
    const manifests = this.app.plugins?.manifests || {};

    return Object.entries(manifests)
      .map(([id, manifest]) => ({
        id,
        name: manifest?.name || id,
        version: manifest?.version || '',
      }))
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name, 'zh-Hans-CN');
        if (byName !== 0) return byName;
        return a.id.localeCompare(b.id, 'en');
      });
  }

  getPluginDisplayName(id) {
    return this.app.plugins?.manifests?.[id]?.name || id;
  }

  shouldSkipPlugin(id) {
    return Boolean(this.settings.skipSelf && id === this.manifest.id);
  }

  isPluginEnabled(id) {
    const manager = this.app.plugins;

    if (manager?.enabledPlugins instanceof Set) {
      return manager.enabledPlugins.has(id);
    }

    if (Array.isArray(manager?.enabledPlugins)) {
      return manager.enabledPlugins.includes(id);
    }

    return Boolean(manager?.plugins?.[id]);
  }

  async enablePluginCompat(id) {
    const manager = this.app.plugins;
    if (typeof manager?.enablePluginAndSave === 'function') {
      return manager.enablePluginAndSave(id);
    }
    if (typeof manager?.enablePlugin === 'function') {
      return manager.enablePlugin(id);
    }
    throw new Error('当前 Obsidian 版本不支持启用插件接口');
  }

  async disablePluginCompat(id) {
    const manager = this.app.plugins;
    if (typeof manager?.disablePluginAndSave === 'function') {
      return manager.disablePluginAndSave(id);
    }
    if (typeof manager?.disablePlugin === 'function') {
      return manager.disablePlugin(id);
    }
    throw new Error('当前 Obsidian 版本不支持关闭插件接口');
  }

  async setPluginState(id, enable) {
    if (this.shouldSkipPlugin(id)) {
      return { status: 'skipped', reason: '已跳过当前插件自身' };
    }

    const manifest = this.app.plugins?.manifests?.[id];
    if (!manifest) {
      return { status: 'skipped', reason: '插件未安装' };
    }

    const enabled = this.isPluginEnabled(id);
    if (enable && enabled) {
      return { status: 'skipped', reason: '插件已开启' };
    }
    if (!enable && !enabled) {
      return { status: 'skipped', reason: '插件已关闭' };
    }

    try {
      if (enable) {
        await this.enablePluginCompat(id);
      } else {
        await this.disablePluginCompat(id);
      }
      return { status: 'changed', reason: enable ? '已开启' : '已关闭' };
    } catch (error) {
      console.error('[plugin-group-toggle] setPluginState failed:', id, error);
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', reason: message };
    }
  }

  showSummaryNotice(summary, details) {
    if (!summary) return;

    if (!this.settings.showNoticeDetails) {
      new Notice(summary, 5000);
      return;
    }

    const lines = [summary, ...details.slice(0, 8)];
    if (details.length > 8) {
      lines.push(`……其余 ${details.length - 8} 项请查看控制台`);
    }

    new Notice(lines.join('\n'), 9000);
    console.log('[plugin-group-toggle]', summary, details);
  }

  async applyPluginState(pluginIds, enable, options = {}) {
    const ids = this.getProcessablePluginIds(pluginIds);
    if (!ids.length) {
      if (!options.silentEmpty) new Notice('没有可处理的插件');
      return { summary: null, details: [], changed: 0, skipped: 0, failed: 0 };
    }

    let changed = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const id of ids) {
      const pluginName = this.getPluginDisplayName(id);
      const result = await this.setPluginState(id, enable);

      if (result.status === 'changed') {
        changed += 1;
        details.push(`${result.reason}：${pluginName}`);
      } else if (result.status === 'failed') {
        failed += 1;
        details.push(`失败：${pluginName} -> ${result.reason}`);
      } else {
        skipped += 1;
        details.push(`跳过：${pluginName} -> ${result.reason}`);
      }
    }

    const summary = `${enable ? '开启' : '关闭'}完成：变更 ${changed} / 跳过 ${skipped} / 失败 ${failed}`;
    if (!options.suppressNotice) {
      this.showSummaryNotice(summary, details);
    }
    return { summary, details, changed, skipped, failed };
  }

  getProcessablePluginIds(pluginIds) {
    return Array.from(new Set((pluginIds || []).map((id) => String(id).trim()).filter(Boolean)));
  }

  getGroupRuntimeState(groupOrName) {
    const group = typeof groupOrName === 'string' ? this.getGroupByName(groupOrName) : groupOrName;
    if (!group) {
      return {
        key: 'missing',
        text: '不存在',
        enabledCount: 0,
        disabledCount: 0,
        skippedCount: 0,
        totalCount: 0,
      };
    }

    const ids = this.getProcessablePluginIds(group.pluginIds);
    let enabledCount = 0;
    let disabledCount = 0;
    let skippedCount = 0;

    for (const id of ids) {
      if (this.shouldSkipPlugin(id)) {
        skippedCount += 1;
        continue;
      }

      const manifest = this.app.plugins?.manifests?.[id];
      if (!manifest) {
        skippedCount += 1;
        continue;
      }

      if (this.isPluginEnabled(id)) {
        enabledCount += 1;
      } else {
        disabledCount += 1;
      }
    }

    const totalCount = ids.length;
    const activeCount = enabledCount + disabledCount;

    if (activeCount === 0) {
      return {
        key: 'empty',
        text: '无可用',
        enabledCount,
        disabledCount,
        skippedCount,
        totalCount,
      };
    }

    if (enabledCount === activeCount) {
      return {
        key: 'enabled',
        text: '开启',
        enabledCount,
        disabledCount,
        skippedCount,
        totalCount,
      };
    }

    if (disabledCount === activeCount) {
      return {
        key: 'disabled',
        text: '关闭',
        enabledCount,
        disabledCount,
        skippedCount,
        totalCount,
      };
    }

    return {
      key: 'mixed',
      text: '部分开启',
      enabledCount,
      disabledCount,
      skippedCount,
      totalCount,
    };
  }


  async runGroupByName(name, enable) {
    const group = this.getGroupByName(name);
    if (!group) {
      new Notice(`场景不存在：${name}`);
      return { summary: null, details: [], changed: 0, skipped: 0, failed: 0 };
    }

    const result = await this.applyPluginState(group.pluginIds, enable);
    if (result.changed > 0) await this.afterGroupAction();
    return result;
  }

  async toggleGroupByName(name) {
    const group = this.getGroupByName(name);
    if (!group) {
      new Notice(`场景不存在：${name}`);
      return { summary: null, details: [], changed: 0, skipped: 0, failed: 0 };
    }

    const state = this.getGroupRuntimeState(group);
    if (state.key === 'empty') {
      new Notice(`场景“${name}”没有可处理的已安装插件`);
      return { summary: null, details: [], changed: 0, skipped: state.skippedCount, failed: 0 };
    }

    // 场景开关采用整体收敛语义：
    // - 全部已开启 -> 整体关闭
    // - 关闭或部分开启 -> 整体开启
    // 避免逐个反转导致“混合状态”被反向混合。
    const enable = state.key !== 'enabled';
    const result = await this.applyPluginState(group.pluginIds, enable, { suppressNotice: true });
    const action = enable ? '开启' : '关闭';
    const summary = `场景“${name}”${action}完成：变更 ${result.changed} / 跳过 ${result.skipped} / 失败 ${result.failed}`;
    this.showSummaryNotice(summary, result.details);

    if (result.changed > 0) await this.afterGroupAction();
    return Object.assign({}, result, { summary, action, targetEnabled: enable });
  }

  async afterGroupAction() {
    if (!this.settings.refreshAfterGroupAction) return;
    await this.refreshCurrentView();
  }

  async refreshCurrentView() {
    try {
      const leaf = this.app.workspace?.getMostRecentLeaf?.();
      const view = leaf?.view;

      if (view?.editor && typeof view.editor.refresh === 'function') {
        view.editor.refresh();
      }

      if (leaf && typeof leaf.getViewState === 'function' && typeof leaf.setViewState === 'function') {
        const state = leaf.getViewState();
        if (state) {
          await leaf.setViewState(state, false);
        }
      }
    } catch (error) {
      console.warn('[plugin-group-toggle] refreshCurrentView failed:', error);
    }
  }

  unregisterGroupCommands() {
    const commands = this.app.commands;
    for (const fullId of this.registeredGroupCommandIds || []) {
      try {
        commands?.removeCommand?.(fullId);
      } catch (error) {
        console.warn('[plugin-group-toggle] removeCommand failed:', fullId, error);
      }
    }
    this.registeredGroupCommandIds = [];
  }

  refreshGroupCommands() {
    this.unregisterGroupCommands();
    this.normalizeGroups();

    const groups = this.getGroups();
    groups.forEach((group) => {
      // 快捷键绑定依赖稳定命令 ID：改名、排序都不改变 sceneId。
      const localId = `toggle-scene-${group.sceneId}`;

      this.addCommand({
        id: localId,
        name: `场景开关：${group.name}`,
        callback: async () => {
          await this.toggleGroupByName(group.name);
        },
      });

      this.registeredGroupCommandIds.push(`${this.manifest.id}:${localId}`);
    });
  }

  async upsertGroup(name, pluginIds) {
    const trimmedName = String(name || '').trim();
    const ids = Array.from(new Set((pluginIds || []).map((id) => String(id).trim()).filter(Boolean)));

    if (!trimmedName) {
      new Notice('场景名称不能为空');
      return false;
    }

    if (!ids.length) {
      new Notice('场景内没有插件');
      return false;
    }

    const groups = this.getGroups();
    const existingIndex = groups.findIndex((group) => group.name === trimmedName);
    const existingSceneId = existingIndex >= 0 ? groups[existingIndex].sceneId : null;
    const usedIds = new Set(groups.map((group) => group.sceneId).filter(Boolean));
    if (existingSceneId) usedIds.delete(existingSceneId);
    const sceneId = this.ensureUniqueSceneId(existingSceneId, trimmedName, usedIds);
    const newGroup = { sceneId, name: trimmedName, pluginIds: ids };

    if (existingIndex >= 0) {
      groups[existingIndex] = newGroup;
    } else {
      groups.push(newGroup);
    }

    this.settings.groups = groups;
    this.normalizeGroups();
    await this.saveSettings();
    this.refreshGroupCommands();
    return true;
  }

  async replaceGroup(oldName, newName, pluginIds) {
    const oldTrimmed = String(oldName || '').trim();
    const newTrimmed = String(newName || '').trim();
    const ids = Array.from(new Set((pluginIds || []).map((id) => String(id).trim()).filter(Boolean)));

    if (!oldTrimmed) {
      new Notice('原场景名称不能为空');
      return false;
    }

    if (!newTrimmed) {
      new Notice('场景名称不能为空');
      return false;
    }

    if (!ids.length) {
      new Notice('场景内至少保留一个插件');
      return false;
    }

    const groups = this.getGroups();
    const targetIndex = groups.findIndex((group) => group.name === oldTrimmed);
    if (targetIndex < 0) {
      new Notice(`场景不存在：${oldTrimmed}`);
      return false;
    }

    const duplicateIndex = groups.findIndex((group) => group.name === newTrimmed && group.name !== oldTrimmed);
    if (duplicateIndex >= 0) {
      new Notice(`已存在同名场景：${newTrimmed}`);
      return false;
    }

    const sceneId = groups[targetIndex].sceneId || this.makeSceneId(oldTrimmed);
    groups[targetIndex] = { sceneId, name: newTrimmed, pluginIds: ids };
    this.settings.groups = groups;
    this.normalizeGroups();
    await this.saveSettings();
    this.refreshGroupCommands();
    return true;
  }

  async deleteGroup(name) {
    const before = this.getGroups().length;
    this.settings.groups = this.getGroups().filter((group) => group.name !== name);
    this.normalizeGroups();
    await this.saveSettings();
    this.refreshGroupCommands();
    return this.getGroups().length !== before;
  }
}

class PluginSelectorModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.plugins = plugin.getInstalledCommunityPlugins();
    this.selectedIds = new Set();
    this.keyword = '';
  }

  onOpen() {
    this.modalEl.addClass('plugin-group-toggle-modal', 'pgt-selector-modal');

    const modalRoot = this.contentEl?.closest?.('.modal') || this.modalEl;
    const modalContainer = this.contentEl?.closest?.('.modal-container');
    [modalContainer, modalRoot, this.modalEl].forEach((el) => {
      if (!el) return;
      el.addClass?.('pgt-selector-modal-shell');
    });
    if (modalRoot?.style) {
      modalRoot.style.width = 'min(1320px, 95vw)';
      modalRoot.style.maxWidth = 'min(1320px, 95vw)';
    }
    if (this.modalEl?.style) {
      this.modalEl.style.width = 'min(1320px, 95vw)';
      this.modalEl.style.maxWidth = 'min(1320px, 95vw)';
    }

    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '打开插件选择器' });

    const desc = contentEl.createDiv({ cls: 'pgt-desc pgt-selector-desc' });
    desc.setText('在这里快速检索社区插件，并批量关闭、启用或保存为场景。当前插件会自动跳过，不会被加入选择。');

    const searchWrap = contentEl.createDiv({ cls: 'pgt-selector-search-wrap' });
    this.searchInput = searchWrap.createEl('input', {
      type: 'text',
      placeholder: '搜索插件名称或 ID…',
      cls: 'pgt-search pgt-selector-search',
    });
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    const toolbar = contentEl.createDiv({ cls: 'pgt-toolbar pgt-selector-toolbar' });
    this.addToolbarButton(toolbar, '全选当前结果', () => this.selectFiltered(), 'pgt-btn-select-all');
    this.addToolbarButton(toolbar, '清空选择', () => {
      this.selectedIds.clear();
      this.renderList();
    }, 'pgt-btn-clear-selection');

    this.counterEl = contentEl.createDiv({ cls: 'pgt-count pgt-selector-count' });
    this.listEl = contentEl.createDiv({ cls: 'pgt-list pgt-selector-list' });
    this.actionBar = contentEl.createDiv({ cls: 'pgt-actions pgt-selector-actions' });

    this.addActionButton('关闭选中插件', true, async () => {
      await this.plugin.applyPluginState(Array.from(this.selectedIds), false);
      this.close();
    }, 'pgt-btn-disable-selected');

    this.addActionButton('启用选中插件', false, async () => {
      await this.plugin.applyPluginState(Array.from(this.selectedIds), true);
      this.close();
    }, 'pgt-btn-enable-selected');

    this.addActionButton('保存为场景', false, async () => {
      if (!this.selectedIds.size) {
        new Notice('请先选择插件');
        return;
      }

      new GroupNameModal(this.app, async (name) => {
        const ok = await this.plugin.upsertGroup(name, Array.from(this.selectedIds));
        if (ok) {
          new Notice(`场景已保存：${name}`);
          this.close();
        }
      }).open();
    }, 'pgt-btn-save-selection');

    this.renderList();
    window.setTimeout(() => this.searchInput?.focus(), 50);
  }

  onClose() {
    const modalRoot = this.contentEl?.closest?.('.modal') || this.modalEl;
    const modalContainer = this.contentEl?.closest?.('.modal-container');

    [modalContainer, modalRoot, this.modalEl].forEach((el) => {
      if (!el) return;
      el.removeClass?.('pgt-selector-modal-shell');
      if (el.style) {
        el.style.width = '';
        el.style.maxWidth = '';
      }
    });

    this.modalEl.removeClass('plugin-group-toggle-modal', 'pgt-selector-modal');
    this.contentEl.empty();
  }

  addToolbarButton(container, text, onClick, extraCls = '') {
    const button = container.createEl('button', { text });
    applyButtonMeta(button, { classes: ['pgt-btn', extraCls], tooltip: text });
    button.addEventListener('click', onClick);
    return button;
  }

  addActionButton(text, primary, onClick, extraCls = '') {
    const button = this.actionBar.createEl('button', {
      text,
      cls: [primary ? 'mod-cta' : '', 'pgt-btn', extraCls].filter(Boolean).join(' '),
    });
    applyButtonMeta(button, { classes: [extraCls], tooltip: text });
    button.addEventListener('click', onClick);
    return button;
  }

  getFilteredPlugins() {
    if (!this.keyword) return this.plugins;
    return this.plugins.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(this.keyword));
  }

  selectFiltered() {
    for (const item of this.getFilteredPlugins()) {
      if (!this.plugin.shouldSkipPlugin(item.id)) {
        this.selectedIds.add(item.id);
      }
    }
    this.renderList();
  }

  toggleSelection(id, checked) {
    if (checked) {
      this.selectedIds.add(id);
    } else {
      this.selectedIds.delete(id);
    }
  }

  renderList() {
    const filtered = this.getFilteredPlugins();
    this.listEl.empty();

    this.counterEl.setText(`已选 ${this.selectedIds.size} 个 / 当前显示 ${filtered.length} 个 / 已安装 ${this.plugins.length} 个`);

    if (!filtered.length) {
      this.listEl.createDiv({ text: '没有匹配到插件', cls: 'pgt-empty' });
      return;
    }

    for (const item of filtered) {
      const enabled = this.plugin.isPluginEnabled(item.id);
      const isSelf = this.plugin.shouldSkipPlugin(item.id);
      const checked = this.selectedIds.has(item.id);

      const row = this.listEl.createDiv({ cls: 'pgt-item pgt-selector-item' });
      if (checked) row.addClass('is-selected');
      if (enabled) row.addClass('is-enabled-now');
      if (!enabled) row.addClass('is-disabled-now');
      if (isSelf) row.addClass('is-self-item');

      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = checked;
      checkbox.disabled = isSelf;
      checkbox.addEventListener('click', (evt) => evt.stopPropagation());
      checkbox.addEventListener('change', () => {
        this.toggleSelection(item.id, checkbox.checked);
        this.renderList();
      });

      const textWrap = row.createDiv({ cls: 'pgt-item-text' });
      textWrap.createDiv({ text: item.name, cls: 'pgt-item-name' });
      textWrap.createDiv({ text: `${item.id}${item.version ? ` · v${item.version}` : ''}`, cls: 'pgt-item-meta' });

      const statusEl = row.createDiv({
        cls: `pgt-item-status ${isSelf ? 'is-self' : enabled ? 'is-enabled' : 'is-disabled'}`,
        text: isSelf ? '当前插件' : enabled ? '开启' : '关闭',
      });
      statusEl.setAttr('data-state', isSelf ? 'self' : enabled ? 'enabled' : 'disabled');

      row.addEventListener('click', () => {
        if (isSelf) return;
        this.toggleSelection(item.id, !checkbox.checked);
        this.renderList();
      });
    }
  }
}

class GroupMultiActionModal extends Modal {
  constructor(app, plugin, mode = 'disable') {
    super(app);
    this.plugin = plugin;
    this.mode = mode;
    this.selectedNames = new Set();
    this.keyword = '';
  }

  onOpen() {
    this.modalEl.addClass('plugin-group-toggle-modal', 'pgt-group-action-modal', this.mode === 'enable' ? 'is-enable-mode' : 'is-disable-mode');

    const modalRoot = this.contentEl?.closest?.('.modal') || this.modalEl;
    const modalContainer = this.contentEl?.closest?.('.modal-container');
    [modalContainer, modalRoot, this.modalEl].forEach((el) => {
      if (!el) return;
      el.addClass?.('pgt-group-action-modal-shell');
    });
    if (modalRoot?.style) {
      modalRoot.style.width = 'min(1120px, 94vw)';
      modalRoot.style.maxWidth = 'min(1120px, 94vw)';
    }
    if (this.modalEl?.style) {
      this.modalEl.style.width = 'min(1120px, 94vw)';
      this.modalEl.style.maxWidth = 'min(1120px, 94vw)';
    }

    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.mode === 'enable' ? '开启插件场景' : '关闭插件场景' });

    const desc = contentEl.createDiv({ cls: 'pgt-desc pgt-group-action-desc' });
    desc.setText(this.mode === 'enable'
      ? '这里只展示当前完全处于关闭状态的场景。选中后可一键批量开启。'
      : '这里只展示当前完全处于开启状态的场景。选中后可一键批量关闭。');

    this.searchInput = contentEl.createEl('input', {
      type: 'text',
      placeholder: '搜索场景名称…',
      cls: 'pgt-search',
    });
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    const toolbar = contentEl.createDiv({ cls: 'pgt-toolbar' });
    this.addToolbarButton(toolbar, '全选当前结果', () => this.selectFiltered(), 'pgt-btn-select-all');
    this.addToolbarButton(toolbar, '清空选择', () => {
      this.selectedNames.clear();
      this.renderList();
    }, 'pgt-btn-clear-selection');

    this.counterEl = contentEl.createDiv({ cls: 'pgt-count' });
    this.listEl = contentEl.createDiv({ cls: 'pgt-list pgt-group-action-list' });
    this.actionBar = contentEl.createDiv({ cls: 'pgt-actions' });

    const primaryText = this.mode === 'enable' ? '开启选中场景' : '关闭选中场景';
    this.addActionButton(primaryText, true, async () => {
      const names = Array.from(this.selectedNames);
      if (!names.length) {
        new Notice('请先选择场景');
        return;
      }

      const collectedDetails = [];
      let executed = 0;

      for (const name of names) {
        const result = await this.plugin.runGroupByName(name, this.mode === 'enable');
        if (result?.summary) {
          executed += 1;
          collectedDetails.push(`[${name}] ${result.summary}`);
        }
      }

      if (executed > 1) {
        this.plugin.showSummaryNotice(
          `${this.mode === 'enable' ? '开启' : '关闭'}场景完成：共处理 ${executed} 个场景`,
          collectedDetails
        );
      }

      this.close();
    }, this.mode === 'enable' ? 'pgt-btn-run-enable' : 'pgt-btn-run-disable');

    this.renderList();
    window.setTimeout(() => this.searchInput?.focus(), 50);
  }

  onClose() {
    const modalRoot = this.contentEl?.closest?.('.modal') || this.modalEl;
    const modalContainer = this.contentEl?.closest?.('.modal-container');

    [modalContainer, modalRoot, this.modalEl].forEach((el) => {
      if (!el) return;
      el.removeClass?.('pgt-group-action-modal-shell');
      if (el.style) {
        el.style.width = '';
        el.style.maxWidth = '';
      }
    });

    this.modalEl.removeClass('plugin-group-toggle-modal', 'pgt-group-action-modal', 'is-enable-mode', 'is-disable-mode');
    this.contentEl.empty();
  }

  addToolbarButton(container, text, onClick, extraCls = '') {
    const button = container.createEl('button', { text });
    applyButtonMeta(button, { classes: ['pgt-btn', extraCls], tooltip: text });
    button.addEventListener('click', onClick);
    return button;
  }

  addActionButton(text, primary, onClick, extraCls = '') {
    const button = this.actionBar.createEl('button', {
      text,
      cls: [primary ? 'mod-cta' : '', 'pgt-btn', extraCls].filter(Boolean).join(' '),
    });
    applyButtonMeta(button, { classes: [extraCls], tooltip: text });
    button.addEventListener('click', onClick);
    return button;
  }

  getEligibleGroups() {
    const groups = this.plugin.getGroups();
    return groups.filter((group) => {
      const state = this.plugin.getGroupRuntimeState(group);
      if (this.mode === 'enable') return state.key === 'disabled';
      if (this.mode === 'disable') return state.key === 'enabled';
      return true;
    });
  }

  getFilteredGroups() {
    const groups = this.getEligibleGroups();
    if (!this.keyword) return groups;
    return groups.filter((group) => group.name.toLowerCase().includes(this.keyword));
  }

  selectFiltered() {
    for (const group of this.getFilteredGroups()) {
      this.selectedNames.add(group.name);
    }
    this.renderList();
  }

  renderList() {
    const filtered = this.getFilteredGroups();
    this.listEl.empty();

    const eligibleCount = this.getEligibleGroups().length;
    this.counterEl.setText(`已选 ${this.selectedNames.size} 个 / 当前显示 ${filtered.length} 个 / 可操作 ${eligibleCount} 个场景`);

    if (!filtered.length) {
      const emptyText = eligibleCount
        ? '没有匹配到场景'
        : this.mode === 'enable'
          ? '当前没有处于关闭状态的场景'
          : '当前没有处于开启状态的场景';
      this.listEl.createDiv({ text: emptyText, cls: 'pgt-empty' });
      return;
    }

    for (const group of filtered) {
      const checked = this.selectedNames.has(group.name);
      const row = this.listEl.createDiv({ cls: 'pgt-item pgt-group-action-item' });
      if (checked) row.addClass('is-selected');

      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = checked;
      checkbox.addEventListener('click', (evt) => evt.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.selectedNames.add(group.name);
        } else {
          this.selectedNames.delete(group.name);
        }
        this.renderList();
      });

      const state = this.plugin.getGroupRuntimeState(group);
      const textWrap = row.createDiv({ cls: 'pgt-item-text' });
      textWrap.createDiv({ text: group.name, cls: 'pgt-item-name' });

      const metaParts = [`${group.pluginIds.length} 个插件`, `${state.enabledCount}/${state.enabledCount + state.disabledCount} 已开启`];
      if (state.skippedCount > 0) {
        metaParts.push(`跳过 ${state.skippedCount}`);
      }
      textWrap.createDiv({ text: metaParts.join(' · '), cls: 'pgt-item-meta' });

      const statusEl = row.createDiv({
        cls: `pgt-item-status ${state.key === 'enabled' ? 'is-enabled' : state.key === 'disabled' ? 'is-disabled' : state.key === 'mixed' ? 'is-mixed' : 'is-self'}`,
        text: state.key === 'enabled' ? '开启' : state.key === 'disabled' ? '关闭' : state.key === 'mixed' ? '混合' : '无可用',
      });
      row.addClass(`is-state-${state.key}`);
      statusEl.setAttr('data-state', state.key);
      statusEl.setAttr('title', `当前状态：${state.text}`);

      row.addEventListener('click', () => {
        if (checkbox.checked) {
          this.selectedNames.delete(group.name);
        } else {
          this.selectedNames.add(group.name);
        }
        this.renderList();
      });
    }
  }
}

class GroupNameModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.modalEl.addClass('plugin-group-toggle-modal');

    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '保存为场景' });

    const row = contentEl.createDiv({ cls: 'pgt-group-row' });
    row.createEl('span', { text: '场景名称' });

    const input = row.createEl('input', {
      type: 'text',
      placeholder: '输入场景名称',
      cls: 'pgt-group-name',
    });

    const actionBar = contentEl.createDiv({ cls: 'pgt-actions' });
    const cancelButton = actionBar.createEl('button', { text: '取消' });
    const saveButton = actionBar.createEl('button', { text: '保存', cls: 'mod-cta pgt-btn-save-group' });
    applyButtonMeta(cancelButton, { classes: ['pgt-btn-cancel'], tooltip: '取消' });
    applyButtonMeta(saveButton, { classes: ['pgt-btn-save-group'], tooltip: '保存场景' });

    cancelButton.addEventListener('click', () => this.close());
    saveButton.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) {
        new Notice('请输入场景名称');
        return;
      }
      await this.onSubmit(name);
      this.close();
    });

    input.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveButton.click();
      }
    });

    window.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.modalEl.removeClass('plugin-group-toggle-modal');
    this.contentEl.empty();
  }
}



class GroupManageModal extends Modal {
  constructor(app, plugin, groupName, onSaved) {
    super(app);
    this.plugin = plugin;
    this.originalGroupName = groupName;
    this.onSaved = onSaved;
    this.keyword = '';

    const group = plugin.getGroupByName(groupName);
    this.groupName = group?.name || groupName;
    this.orderedPluginIds = this.normalizeOrderedIds(group?.pluginIds || []);
    this.selectedIds = new Set(this.orderedPluginIds);
    this.installedPlugins = plugin.getInstalledCommunityPlugins();
  }

  normalizeOrderedIds(ids) {
    const result = [];
    const seen = new Set();
    for (const raw of ids || []) {
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  syncSelectedIds() {
    this.orderedPluginIds = this.normalizeOrderedIds(this.orderedPluginIds);
    this.selectedIds = new Set(this.orderedPluginIds);
  }

  onOpen() {
    this.modalEl.addClass('plugin-group-toggle-modal', 'pgt-manage-modal', 'pgt-gm2-modal');

    const modalRoot = this.contentEl?.closest?.('.modal') || this.modalEl;
    const modalContainer = this.contentEl?.closest?.('.modal-container');

    [modalContainer, modalRoot, this.modalEl].forEach((el) => {
      if (!el) return;
      el.addClass?.('pgt-manage-modal-shell', 'pgt-gm2-shell');
    });

    if (modalRoot?.style) {
      modalRoot.style.width = 'min(1500px, 96vw)';
      modalRoot.style.maxWidth = 'min(1500px, 96vw)';
    }
    if (this.modalEl?.style) {
      this.modalEl.style.width = 'min(1500px, 96vw)';
      this.modalEl.style.maxWidth = 'min(1500px, 96vw)';
    }

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('pgt-gm2-root');

    const title = contentEl.createEl('h2', { text: `管理场景：${this.originalGroupName}` });
    title.addClass('pgt-gm2-title');

    const topGrid = contentEl.createDiv({ cls: 'pgt-gm2-top' });

    const nameBlock = topGrid.createDiv({ cls: 'pgt-gm2-block pgt-gm2-name-block' });
    nameBlock.createDiv({ text: '场景名称', cls: 'pgt-gm2-label' });
    this.nameInput = nameBlock.createEl('input', {
      type: 'text',
      value: this.groupName,
      placeholder: '输入场景名称',
      cls: 'pgt-group-name pgt-gm2-input',
    });

    const searchBlock = topGrid.createDiv({ cls: 'pgt-gm2-block pgt-gm2-search-block' });
    searchBlock.createDiv({ text: '添加插件搜索', cls: 'pgt-gm2-label' });
    this.searchInput = searchBlock.createEl('input', {
      type: 'text',
      placeholder: '搜索可加入该场景的插件名称或 ID…',
      cls: 'pgt-search pgt-gm2-input',
    });
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value.trim().toLowerCase();
      this.renderAvailableList();
    });

    const body = contentEl.createDiv({ cls: 'pgt-gm2-body' });
    this.selectedPane = body.createDiv({ cls: 'pgt-gm2-pane pgt-gm2-pane-selected' });
    this.availablePane = body.createDiv({ cls: 'pgt-gm2-pane pgt-gm2-pane-available' });

    this.buildSelectedPane();
    this.buildAvailablePane();

    this.actionBar = contentEl.createDiv({ cls: 'pgt-actions pgt-gm2-actions' });
    const cancelButton = this.actionBar.createEl('button', { text: '取消', cls: 'pgt-btn pgt-gm2-btn-cancel' });
    const saveButton = this.actionBar.createEl('button', { text: '保存修改', cls: 'mod-cta pgt-btn pgt-gm2-btn-save' });
    applyButtonMeta(cancelButton, { classes: ['pgt-gm2-btn-cancel'], tooltip: '取消' });
    applyButtonMeta(saveButton, { classes: ['pgt-gm2-btn-save'], tooltip: '保存修改' });

    cancelButton.addEventListener('click', () => this.close());
    saveButton.addEventListener('click', async () => {
      const newName = this.nameInput.value.trim();
      if (!newName) {
        new Notice('请输入场景名称');
        return;
      }
      if (!this.orderedPluginIds.length) {
        new Notice('场景内至少保留一个插件');
        return;
      }

      const ok = await this.plugin.replaceGroup(this.originalGroupName, newName, this.orderedPluginIds);
      if (!ok) return;

      new Notice(`场景已更新：${newName}`);
      this.originalGroupName = newName;
      this.groupName = newName;
      if (typeof this.onSaved === 'function') this.onSaved(newName);
      this.close();
    });

    this.renderAll();
    window.setTimeout(() => this.searchInput?.focus(), 50);
  }

  buildSelectedPane() {
    const head = this.selectedPane.createDiv({ cls: 'pgt-gm2-pane-head' });
    head.createDiv({ text: '场景内插件条目', cls: 'pgt-gm2-pane-title' });
    this.selectedCounterEl = head.createDiv({ cls: 'pgt-gm2-pane-count' });

    this.selectedToolbar = this.selectedPane.createDiv({ cls: 'pgt-toolbar pgt-gm2-toolbar' });
    this.createToolbarButton(this.selectedToolbar, '按名称排序', () => {
      this.orderedPluginIds.sort((a, b) =>
        this.plugin.getPluginDisplayName(a).localeCompare(this.plugin.getPluginDisplayName(b), 'zh-Hans-CN')
      );
      this.syncSelectedIds();
      this.renderSelectedList();
    }, 'pgt-gm2-btn-sort');

    this.createToolbarButton(this.selectedToolbar, '清空场景', () => {
      this.orderedPluginIds = [];
      this.syncSelectedIds();
      this.renderAll();
    }, 'pgt-gm2-btn-clear');

    this.createToolbarButton(this.selectedToolbar, '删除整个场景', async () => {
      const ok = await this.plugin.deleteGroup(this.originalGroupName);
      if (ok) {
        new Notice(`已删除场景：${this.originalGroupName}`);
        if (typeof this.onSaved === 'function') this.onSaved('');
        this.close();
      }
    }, 'pgt-gm2-btn-delete-group');

    this.selectedEmptyEl = this.selectedPane.createDiv({
      cls: 'pgt-gm2-empty pgt-gm2-selected-empty',
      text: '当前场景为空，可从右侧添加插件。',
    });
    this.selectedListEl = this.selectedPane.createDiv({ cls: 'pgt-gm2-list pgt-gm2-selected-list' });
  }

  buildAvailablePane() {
    const head = this.availablePane.createDiv({ cls: 'pgt-gm2-pane-head' });
    head.createDiv({ text: '可添加插件', cls: 'pgt-gm2-pane-title' });
    this.availableCounterEl = head.createDiv({ cls: 'pgt-gm2-pane-count' });

    this.availableToolbar = this.availablePane.createDiv({ cls: 'pgt-toolbar pgt-gm2-toolbar' });
    this.createToolbarButton(this.availableToolbar, '添加当前结果', () => {
      const filtered = this.getFilteredAvailablePlugins();
      for (const item of filtered) this.addPlugin(item.id);
      this.renderAll();
    }, 'pgt-gm2-btn-add-all');

    this.availableEmptyEl = this.availablePane.createDiv({
      cls: 'pgt-gm2-empty pgt-gm2-available-empty',
      text: '当前没有可添加插件。',
    });
    this.availableListEl = this.availablePane.createDiv({ cls: 'pgt-gm2-list pgt-gm2-available-list' });
  }

  onClose() {
    const modalRoot = this.contentEl?.closest?.('.modal') || this.modalEl;
    const modalContainer = this.contentEl?.closest?.('.modal-container');

    [modalContainer, modalRoot, this.modalEl].forEach((el) => {
      if (!el) return;
      el.removeClass?.('pgt-manage-modal-shell', 'pgt-gm2-shell');
      if (el.style) {
        el.style.width = '';
        el.style.maxWidth = '';
      }
    });

    this.modalEl.removeClass('plugin-group-toggle-modal', 'pgt-manage-modal', 'pgt-gm2-modal');
    this.contentEl.empty();
  }

  createToolbarButton(container, text, onClick, extraCls = '') {
    const button = container.createEl('button', { text, cls: ['pgt-btn', extraCls].filter(Boolean).join(' ') });
    applyButtonMeta(button, { classes: [extraCls], tooltip: text, ariaLabel: text });
    button.addEventListener('click', onClick);
    return button;
  }

  createNativeMiniButton(container, text, title, onClick, disabled = false, extraCls = '') {
    const button = container.createEl('button', {
      text,
      cls: ['pgt-mini-btn', ...normalizeClassList(extraCls)].join(' '),
    });
    applyButtonMeta(button, { classes: normalizeClassList(extraCls), tooltip: title, ariaLabel: title });
    button.disabled = Boolean(disabled);
    button.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (button.disabled) return;
      onClick();
    });
    return button;
  }

  getFilteredAvailablePlugins() {
    this.syncSelectedIds();
    return this.installedPlugins.filter((item) => {
      if (this.selectedIds.has(item.id)) return false;
      if (this.plugin.shouldSkipPlugin(item.id)) return false;
      const text = `${item.name} ${item.id}`.toLowerCase();
      return !this.keyword || text.includes(this.keyword);
    });
  }

  addPlugin(id) {
    if (this.plugin.shouldSkipPlugin(id)) return;
    if (this.selectedIds.has(id)) return;
    this.orderedPluginIds.push(id);
    this.syncSelectedIds();
  }

  removePlugin(id) {
    this.orderedPluginIds = this.orderedPluginIds.filter((item) => item !== id);
    this.syncSelectedIds();
  }

  movePlugin(id, direction) {
    const index = this.orderedPluginIds.indexOf(id);
    if (index < 0) return;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= this.orderedPluginIds.length) return;
    const next = Array.from(this.orderedPluginIds);
    [next[index], next[target]] = [next[target], next[index]];
    this.orderedPluginIds = next;
    this.syncSelectedIds();
  }

  getInstalledSelectablePluginCount() {
    return this.installedPlugins.filter((item) => !this.plugin.shouldSkipPlugin(item.id)).length;
  }

  getSelectedInstalledPluginCount() {
    const installedIdSet = new Set(this.installedPlugins.map((item) => item.id));
    return this.orderedPluginIds.filter((id) => installedIdSet.has(id) && !this.plugin.shouldSkipPlugin(id)).length;
  }

  renderAll() {
    this.renderSelectedList();
    this.renderAvailableList();
  }

  renderSelectedList() {
    this.syncSelectedIds();
    const items = Array.from(this.orderedPluginIds);
    const count = items.length;
    this.selectedCounterEl.setText(`当前共 ${count} 个插件条目 / 已安装可用 ${this.getSelectedInstalledPluginCount()} 个`);
    this.selectedListEl.empty();

    const hasItems = count > 0;
    this.selectedListEl.style.display = hasItems ? 'flex' : 'none';
    this.selectedEmptyEl.style.display = hasItems ? 'none' : 'flex';
    if (!hasItems) return;

    items.forEach((id, index) => {
      const enabled = this.plugin.isPluginEnabled(id);
      const exists = Boolean(this.app.plugins?.manifests?.[id]);
      const row = this.selectedListEl.createDiv({ cls: 'pgt-gm2-item pgt-gm2-selected-item' });
      row.setAttr('data-state', !exists ? 'missing' : enabled ? 'enabled' : 'disabled');

      const textWrap = row.createDiv({ cls: 'pgt-item-text' });
      textWrap.createDiv({ text: `${index + 1}. ${this.plugin.getPluginDisplayName(id)}`, cls: 'pgt-item-name' });
      const metaParts = [id];
      if (!exists) metaParts.push('未安装');
      else metaParts.push(enabled ? '当前已开启' : '当前已关闭');
      textWrap.createDiv({ text: metaParts.join(' · '), cls: 'pgt-item-meta' });

      const bottom = row.createDiv({ cls: 'pgt-gm2-item-bottom' });
      const statusEl = bottom.createDiv({
        cls: `pgt-item-status ${!exists ? 'is-self' : enabled ? 'is-enabled' : 'is-disabled'}`,
        text: !exists ? '未安装' : enabled ? '开启' : '关闭',
      });
      statusEl.setAttr('data-state', !exists ? 'missing' : enabled ? 'enabled' : 'disabled');

      const actions = bottom.createDiv({ cls: 'pgt-inline-actions pgt-gm2-actions-inline' });
      this.createNativeMiniButton(
        actions,
        enabled ? '关闭' : '开启',
        exists ? `${enabled ? '关闭' : '开启'}该插件` : '插件未安装，无法切换',
        async () => {
          if (!exists) return;
          const result = await this.plugin.setPluginState(id, !enabled);
          if (result?.status === 'changed') {
            new Notice(`${enabled ? '已关闭' : '已开启'}：${this.plugin.getPluginDisplayName(id)}`);
            await this.plugin.afterGroupAction();
          } else if (result?.reason) {
            new Notice(`${this.plugin.getPluginDisplayName(id)}：${result.reason}`);
          }
          this.renderAll();
        },
        !exists || this.plugin.shouldSkipPlugin(id),
        `pgt-gm2-btn-mini pgt-gm2-btn-toggle-plugin ${enabled ? 'is-enabled' : 'is-disabled'}`
      );

      this.createNativeMiniButton(actions, '上移', '上移', () => {
        this.movePlugin(id, 'up');
        this.renderSelectedList();
      }, index === 0, 'pgt-gm2-btn-mini pgt-gm2-btn-move-up');

      this.createNativeMiniButton(actions, '下移', '下移', () => {
        this.movePlugin(id, 'down');
        this.renderSelectedList();
      }, index === items.length - 1, 'pgt-gm2-btn-mini pgt-gm2-btn-move-down');

      this.createNativeMiniButton(actions, '移除', '从场景中移除该插件', () => {
        this.removePlugin(id);
        this.renderAll();
      }, false, 'pgt-gm2-btn-mini pgt-gm2-btn-remove pgt-gm2-btn-delete-plugin');
    });
  }

  renderAvailableList() {
    this.syncSelectedIds();
    const filtered = this.getFilteredAvailablePlugins();
    const selectableTotal = this.getInstalledSelectablePluginCount();
    const selectedInstalled = this.getSelectedInstalledPluginCount();
    this.availableCounterEl.setText(`当前可添加 ${filtered.length} 个 / 已安装可选 ${selectableTotal} 个 / 已在场景 ${selectedInstalled} 个`);
    this.availableListEl.empty();

    const hasItems = filtered.length > 0;
    this.availableListEl.style.display = hasItems ? 'grid' : 'none';
    this.availableEmptyEl.style.display = hasItems ? 'none' : 'flex';
    if (this.keyword) {
      this.availableEmptyEl.setText('没有匹配到可添加插件');
    } else if (selectedInstalled >= selectableTotal && selectableTotal > 0) {
      this.availableEmptyEl.setText(`当前没有可添加插件：已安装的 ${selectableTotal} 个社区插件已全部在本场景中。请先在左侧移除部分插件。`);
    } else {
      this.availableEmptyEl.setText('当前没有可添加插件（可能都已在场景内，或仅剩当前插件自身）');
    }
    if (!hasItems) return;

    filtered.forEach((item) => {
      const enabled = this.plugin.isPluginEnabled(item.id);
      const row = this.availableListEl.createDiv({ cls: 'pgt-gm2-item pgt-gm2-available-item' });
      row.setAttr('data-state', enabled ? 'enabled' : 'disabled');

      const textWrap = row.createDiv({ cls: 'pgt-item-text' });
      textWrap.createDiv({ text: item.name, cls: 'pgt-item-name' });
      textWrap.createDiv({ text: `${item.id}${item.version ? ` · v${item.version}` : ''}`, cls: 'pgt-item-meta' });

      const bottom = row.createDiv({ cls: 'pgt-gm2-item-bottom' });
      const statusEl = bottom.createDiv({
        cls: `pgt-item-status ${enabled ? 'is-enabled' : 'is-disabled'}`,
        text: enabled ? '开启' : '关闭',
      });
      statusEl.setAttr('data-state', enabled ? 'enabled' : 'disabled');

      const actions = bottom.createDiv({ cls: 'pgt-inline-actions pgt-gm2-actions-inline' });
      this.createNativeMiniButton(actions, '添加', '添加到场景', () => {
        this.addPlugin(item.id);
        this.renderAll();
      }, false, 'pgt-gm2-btn-mini pgt-gm2-btn-add');
    });
  }
}


class PluginGroupToggleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('pgt-settings-tab');

    containerEl.createEl('h2', { text: '插件场景开关' });
    containerEl.createDiv({
      text: '每个已保存场景都会自动暴露“场景开关：名称”命令，可直接在 Obsidian「快捷键」中绑定。场景部分开启时，调用命令会先整体开启；全部开启后再次调用则整体关闭。',
      cls: 'pgt-settings-intro',
    });

    new Setting(containerEl)
      .setName('快速操作')
      .setDesc('从设置页直接打开插件选择器，或批量开启 / 关闭已保存场景。')
      .addButton((button) =>
        decorateButtonComponent(button.setButtonText('打开插件选择器').setCta(), { classes: ['pgt-qa-open-selector'], tooltip: '打开插件选择器' }).onClick(() => {
          new PluginSelectorModal(this.app, this.plugin).open();
        })
      )
      .addButton((button) =>
        decorateButtonComponent(button.setButtonText('批量关闭场景'), { classes: ['pgt-qa-close-group'], tooltip: '批量关闭场景' }).onClick(() => {
          if (!this.plugin.getGroups().length) {
            new Notice('当前还没有插件场景');
            return;
          }
          new GroupMultiActionModal(this.app, this.plugin, 'disable').open();
        })
      )
      .addButton((button) =>
        decorateButtonComponent(button.setButtonText('批量开启场景'), { classes: ['pgt-qa-open-group'], tooltip: '批量开启场景' }).onClick(() => {
          if (!this.plugin.getGroups().length) {
            new Notice('当前还没有插件场景');
            return;
          }
          new GroupMultiActionModal(this.app, this.plugin, 'enable').open();
        })
      );

    new Setting(containerEl)
      .setName('跳过当前插件自身')
      .setDesc('开启后，插件不会对自己执行启用/关闭。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipSelf).onChange(async (value) => {
          this.plugin.settings.skipSelf = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('显示详细通知')
      .setDesc('执行后在通知中展示部分明细。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showNoticeDetails).onChange(async (value) => {
          this.plugin.settings.showNoticeDetails = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('场景操作后自动刷新当前页面')
      .setDesc('在执行单场景命令、批量开启场景、批量关闭场景后刷新当前视图。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.refreshAfterGroupAction).onChange(async (value) => {
          this.plugin.settings.refreshAfterGroupAction = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: '已保存场景' });

    const groups = this.plugin.getGroups();
    if (!groups.length) {
      containerEl.createDiv({ text: '当前还没有保存任何场景。' });
      return;
    }

    this.renderSavedGroups(containerEl, groups);
  }

  renderSavedGroups(containerEl, groups) {
    const wrap = containerEl.createDiv({ cls: 'pgt-saved-groups-wrap' });

    groups.forEach((group) => {
      const state = this.plugin.getGroupRuntimeState(group);
      const activeCount = state.enabledCount + state.disabledCount;
      const previewIds = group.pluginIds.slice(0, 8);

      const card = wrap.createDiv({ cls: 'pgt-saved-group-card' });
      card.setAttr('data-state', state.key);

      const header = card.createDiv({ cls: 'pgt-saved-group-header' });
      header.createDiv({ text: group.name, cls: 'pgt-saved-group-name' });
      const badge = header.createDiv({ text: state.text, cls: 'pgt-saved-group-state' });
      badge.setAttr('data-state', state.key);

      const meta = card.createDiv({ cls: 'pgt-saved-group-meta' });
      meta.createSpan({ text: `${group.pluginIds.length} 个插件`, cls: 'pgt-saved-group-meta-item' });
      meta.createSpan({ text: `已开启 ${state.enabledCount}`, cls: 'pgt-saved-group-meta-item' });
      meta.createSpan({ text: `已关闭 ${state.disabledCount}`, cls: 'pgt-saved-group-meta-item' });
      if (state.skippedCount > 0) {
        meta.createSpan({ text: `跳过 ${state.skippedCount}`, cls: 'pgt-saved-group-meta-item' });
      }
      if (activeCount === 0) {
        meta.createSpan({ text: '当前无可用插件', cls: 'pgt-saved-group-meta-item is-empty' });
      }

      const commandEl = card.createDiv({ cls: 'pgt-saved-group-command' });
      commandEl.setText(`命令：场景开关：${group.name}（可在快捷键中绑定）`);

      const previewWrap = card.createDiv({ cls: 'pgt-saved-group-preview' });
      if (!group.pluginIds.length) {
        previewWrap.createDiv({ text: '当前场景为空', cls: 'pgt-saved-group-empty' });
      } else {
        previewIds.forEach((id) => {
          const exists = Boolean(this.plugin.app.plugins?.manifests?.[id]);
          const enabled = exists ? this.plugin.isPluginEnabled(id) : false;
          const canToggle = exists && !this.plugin.shouldSkipPlugin(id);
          const chip = previewWrap.createDiv({ cls: `pgt-saved-plugin-chip ${canToggle ? 'is-clickable' : 'is-static'}` });
          chip.setAttr('data-state', exists ? (enabled ? 'enabled' : 'disabled') : 'missing');
          chip.setAttr('title', canToggle ? `点击${enabled ? '关闭' : '开启'}：${this.plugin.getPluginDisplayName(id)}` : '插件未安装或已被跳过');
          chip.createSpan({ text: this.plugin.getPluginDisplayName(id), cls: 'pgt-saved-plugin-chip-name' });
          const sub = chip.createSpan({ text: exists ? (enabled ? '开启' : '关闭') : '未安装', cls: 'pgt-saved-plugin-chip-state' });
          sub.setAttr('data-state', exists ? (enabled ? 'enabled' : 'disabled') : 'missing');

          if (canToggle) {
            chip.addEventListener('click', async (evt) => {
              evt.preventDefault();
              evt.stopPropagation();
              const result = await this.plugin.setPluginState(id, !enabled);
              if (result?.status === 'changed') {
                new Notice(`${enabled ? '已关闭' : '已开启'}：${this.plugin.getPluginDisplayName(id)}`);
                await this.plugin.afterGroupAction();
              } else if (result?.reason) {
                new Notice(`${this.plugin.getPluginDisplayName(id)}：${result.reason}`);
              }
              this.display();
            });
          }
        });
        if (group.pluginIds.length > previewIds.length) {
          previewWrap.createDiv({ text: `+${group.pluginIds.length - previewIds.length} 个`, cls: 'pgt-saved-plugin-chip is-more' });
        }
      }

      const actions = card.createDiv({ cls: 'pgt-saved-group-actions' });

      const manageBtn = actions.createEl('button', { text: '管理条目' });
      applyButtonMeta(manageBtn, { classes: ['mod-cta', 'pgt-btn-manage-group'], tooltip: '管理条目', ariaLabel: `管理场景 ${group.name}` });
      manageBtn.addEventListener('click', () => {
        new GroupManageModal(this.app, this.plugin, group.name, () => this.display()).open();
      });

      const toggleBtn = actions.createEl('button', { text: '开关' });
      applyButtonMeta(toggleBtn, { classes: ['pgt-btn-toggle-group'], tooltip: '开关场景', ariaLabel: `开关场景 ${group.name}` });
      toggleBtn.addEventListener('click', async () => {
        await this.plugin.toggleGroupByName(group.name);
        this.display();
      });

      const deleteBtn = actions.createEl('button', { text: '删除' });
      applyButtonMeta(deleteBtn, { classes: ['warning', 'pgt-btn-delete-group'], tooltip: '删除场景', ariaLabel: `删除场景 ${group.name}` });
      deleteBtn.addEventListener('click', async () => {
        const ok = await this.plugin.deleteGroup(group.name);
        if (ok) {
          new Notice(`已删除场景：${group.name}`);
          this.display();
        }
      });
    });
  }
}

module.exports = PluginGroupTogglePlugin;