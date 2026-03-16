const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  skipSelf: true,
  showNoticeDetails: true,
  refreshAfterGroupAction: true,
  groups: [],
};

class PluginGroupTogglePlugin extends Plugin {
  async onload() {
    this.registeredGroupCommandIds = [];

    try {
      await this.loadSettings();
      this.normalizeGroups();

      this.addCommand({
        id: 'open-plugin-selector',
        name: '弹出插件选择器',
        callback: () => new PluginSelectorModal(this.app, this).open(),
      });

      this.addCommand({
        id: 'disable-plugin-groups',
        name: '关闭插件分组',
        callback: () => {
          if (!this.getGroups().length) {
            new Notice('当前还没有插件分组');
            return;
          }
          new GroupMultiActionModal(this.app, this, 'disable').open();
        },
      });

      this.addCommand({
        id: 'enable-plugin-groups',
        name: '开启插件分组',
        callback: () => {
          if (!this.getGroups().length) {
            new Notice('当前还没有插件分组');
            return;
          }
          new GroupMultiActionModal(this.app, this, 'enable').open();
        },
      });

      this.addRibbonIcon('boxes', '插件分组开关闭：弹出插件选择器', () => {
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    if (!Array.isArray(this.settings.groups)) this.settings.groups = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getGroups() {
    return Array.isArray(this.settings.groups) ? this.settings.groups : [];
  }

  normalizeGroups() {
    const map = new Map();

    for (const rawGroup of this.getGroups()) {
      const name = String(rawGroup?.name || '').trim();
      const pluginIds = Array.from(
        new Set((rawGroup?.pluginIds || []).map((id) => String(id).trim()).filter(Boolean))
      );

      if (!name || !pluginIds.length) continue;
      map.set(name, { name, pluginIds });
    }

    this.settings.groups = Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN')
    );
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
      return { summary: null, details: [] };
    }

    let changed = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const id of ids) {
      const pluginName = this.app.plugins?.manifests?.[id]?.name || id;
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
    return { summary, details };
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
      text: '混合',
      enabledCount,
      disabledCount,
      skippedCount,
      totalCount,
    };
  }

  async togglePluginsIndividually(pluginIds, options = {}) {
    const ids = this.getProcessablePluginIds(pluginIds);
    if (!ids.length) {
      if (!options.silentEmpty) new Notice('没有可处理的插件');
      return { summary: null, details: [] };
    }

    let changed = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const id of ids) {
      const current = this.isPluginEnabled(id);
      const pluginName = this.app.plugins?.manifests?.[id]?.name || id;
      const result = await this.setPluginState(id, !current);

      if (result.status === 'changed') {
        changed += 1;
        details.push(`${current ? '关闭' : '开启'}：${pluginName}`);
      } else if (result.status === 'failed') {
        failed += 1;
        details.push(`失败：${pluginName} -> ${result.reason}`);
      } else {
        skipped += 1;
        details.push(`跳过：${pluginName} -> ${result.reason}`);
      }
    }

    const summary = `分组开关完成：变更 ${changed} / 跳过 ${skipped} / 失败 ${failed}`;
    if (!options.suppressNotice) {
      this.showSummaryNotice(summary, details);
    }
    return { summary, details };
  }

  async runGroupByName(name, enable) {
    const group = this.getGroupByName(name);
    if (!group) {
      new Notice(`分组不存在：${name}`);
      return { summary: null, details: [] };
    }

    const result = await this.applyPluginState(group.pluginIds, enable);
    await this.afterGroupAction();
    return result;
  }

  async toggleGroupByName(name) {
    const group = this.getGroupByName(name);
    if (!group) {
      new Notice(`分组不存在：${name}`);
      return { summary: null, details: [] };
    }

    const result = await this.togglePluginsIndividually(group.pluginIds);
    await this.afterGroupAction();
    return result;
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

  sanitizeCommandIdPart(text) {
    const encoded = encodeURIComponent(String(text || '').trim());
    return encoded || 'group';
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
    groups.forEach((group, index) => {
      const suffix = `${String(index + 1).padStart(3, '0')}-${this.sanitizeCommandIdPart(group.name)}`;
      const localId = `toggle-group-${suffix}`;

      this.addCommand({
        id: localId,
        name: `开关分组：${group.name}`,
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
      new Notice('分组名称不能为空');
      return false;
    }

    if (!ids.length) {
      new Notice('分组内没有插件');
      return false;
    }

    const groups = this.getGroups();
    const existingIndex = groups.findIndex((group) => group.name === trimmedName);
    const newGroup = { name: trimmedName, pluginIds: ids };

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
    this.modalEl.addClass('plugin-group-toggle-modal');

    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '选择插件' });

    const desc = contentEl.createDiv({ cls: 'pgt-desc' });
    desc.setText('默认主操作为关闭选中插件。你也可以保存为分组；保存后该分组会自动注册为独立命令。');

    this.searchInput = contentEl.createEl('input', {
      type: 'text',
      placeholder: '搜索插件名称或 ID…',
      cls: 'pgt-search',
    });
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    const toolbar = contentEl.createDiv({ cls: 'pgt-toolbar' });
    this.addToolbarButton(toolbar, '全选当前结果', () => this.selectFiltered());
    this.addToolbarButton(toolbar, '清空选择', () => {
      this.selectedIds.clear();
      this.renderList();
    });

    this.counterEl = contentEl.createDiv({ cls: 'pgt-count' });
    this.listEl = contentEl.createDiv({ cls: 'pgt-list' });
    this.actionBar = contentEl.createDiv({ cls: 'pgt-actions' });

    this.addActionButton('关闭选中插件', true, async () => {
      await this.plugin.applyPluginState(Array.from(this.selectedIds), false);
      this.close();
    });

    this.addActionButton('启用选中插件', false, async () => {
      await this.plugin.applyPluginState(Array.from(this.selectedIds), true);
      this.close();
    });

    this.addActionButton('保存为分组', false, async () => {
      if (!this.selectedIds.size) {
        new Notice('请先选择插件');
        return;
      }

      new GroupNameModal(this.app, async (name) => {
        const ok = await this.plugin.upsertGroup(name, Array.from(this.selectedIds));
        if (ok) {
          new Notice(`分组已保存：${name}`);
          this.close();
        }
      }).open();
    });

    this.renderList();
    window.setTimeout(() => this.searchInput?.focus(), 50);
  }

  onClose() {
    this.modalEl.removeClass('plugin-group-toggle-modal');
    this.contentEl.empty();
  }

  addToolbarButton(container, text, onClick) {
    const button = container.createEl('button', { text });
    button.addEventListener('click', onClick);
  }

  addActionButton(text, primary, onClick) {
    const button = this.actionBar.createEl('button', { text, cls: primary ? 'mod-cta' : '' });
    button.addEventListener('click', onClick);
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

      const row = this.listEl.createDiv({ cls: 'pgt-item' });
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
    this.modalEl.addClass('plugin-group-toggle-modal');

    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.mode === 'enable' ? '开启插件分组' : '关闭插件分组' });

    this.searchInput = contentEl.createEl('input', {
      type: 'text',
      placeholder: '搜索分组名称…',
      cls: 'pgt-search',
    });
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    const toolbar = contentEl.createDiv({ cls: 'pgt-toolbar' });
    this.addToolbarButton(toolbar, '全选当前结果', () => this.selectFiltered());
    this.addToolbarButton(toolbar, '清空选择', () => {
      this.selectedNames.clear();
      this.renderList();
    });

    this.counterEl = contentEl.createDiv({ cls: 'pgt-count' });
    this.listEl = contentEl.createDiv({ cls: 'pgt-list' });
    this.actionBar = contentEl.createDiv({ cls: 'pgt-actions' });

    const primaryText = this.mode === 'enable' ? '开启选中分组' : '关闭选中分组';
    this.addActionButton(primaryText, true, async () => {
      const names = Array.from(this.selectedNames);
      if (!names.length) {
        new Notice('请先选择分组');
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
          `${this.mode === 'enable' ? '开启' : '关闭'}分组完成：共处理 ${executed} 个分组`,
          collectedDetails
        );
      }

      this.close();
    });

    this.renderList();
    window.setTimeout(() => this.searchInput?.focus(), 50);
  }

  onClose() {
    this.modalEl.removeClass('plugin-group-toggle-modal');
    this.contentEl.empty();
  }

  addToolbarButton(container, text, onClick) {
    const button = container.createEl('button', { text });
    button.addEventListener('click', onClick);
  }

  addActionButton(text, primary, onClick) {
    const button = this.actionBar.createEl('button', { text, cls: primary ? 'mod-cta' : '' });
    button.addEventListener('click', onClick);
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
    this.counterEl.setText(`已选 ${this.selectedNames.size} 个 / 当前显示 ${filtered.length} 个 / 可操作 ${eligibleCount} 个分组`);

    if (!filtered.length) {
      const emptyText = eligibleCount
        ? '没有匹配到分组'
        : this.mode === 'enable'
          ? '当前没有处于关闭状态的分组'
          : '当前没有处于开启状态的分组';
      this.listEl.createDiv({ text: emptyText, cls: 'pgt-empty' });
      return;
    }

    for (const group of filtered) {
      const checked = this.selectedNames.has(group.name);
      const row = this.listEl.createDiv({ cls: 'pgt-item' });
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
        text: state.text,
      });
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

    contentEl.createEl('h2', { text: '保存为分组' });

    const row = contentEl.createDiv({ cls: 'pgt-group-row' });
    row.createEl('span', { text: '分组名称' });

    const input = row.createEl('input', {
      type: 'text',
      placeholder: '输入分组名称',
      cls: 'pgt-group-name',
    });

    const actionBar = contentEl.createDiv({ cls: 'pgt-actions' });
    const cancelButton = actionBar.createEl('button', { text: '取消' });
    const saveButton = actionBar.createEl('button', { text: '保存', cls: 'mod-cta' });

    cancelButton.addEventListener('click', () => this.close());
    saveButton.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) {
        new Notice('请输入分组名称');
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

class PluginGroupToggleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '插件分组开关闭' });

    new Setting(containerEl)
      .setName('快速操作')
      .setDesc('从设置页直接打开插件选择器，或批量开启 / 关闭已保存分组。')
      .addButton((button) =>
        button.setButtonText('打开插件选择器').setCta().onClick(() => {
          new PluginSelectorModal(this.app, this.plugin).open();
        })
      )
      .addButton((button) =>
        button.setButtonText('关闭插件分组').onClick(() => {
          if (!this.plugin.getGroups().length) {
            new Notice('当前还没有插件分组');
            return;
          }
          new GroupMultiActionModal(this.app, this.plugin, 'disable').open();
        })
      )
      .addButton((button) =>
        button.setButtonText('开启插件分组').onClick(() => {
          if (!this.plugin.getGroups().length) {
            new Notice('当前还没有插件分组');
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
      .setName('分组操作后自动刷新当前页面')
      .setDesc('在执行单分组命令、批量开启分组、批量关闭分组后刷新当前视图。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.refreshAfterGroupAction).onChange(async (value) => {
          this.plugin.settings.refreshAfterGroupAction = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: '已保存分组' });

    const groups = this.plugin.getGroups();
    if (!groups.length) {
      containerEl.createDiv({ text: '当前还没有保存任何分组。' });
      return;
    }

    for (const group of groups) {
      new Setting(containerEl)
        .setName(group.name)
        .setDesc(`${group.pluginIds.length} 个插件｜命令：开关分组：${group.name}`)
        .addButton((button) =>
          button.setButtonText('开关').onClick(async () => {
            await this.plugin.toggleGroupByName(group.name);
          })
        )
        .addButton((button) =>
          button.setButtonText('删除').setWarning().onClick(async () => {
            const ok = await this.plugin.deleteGroup(group.name);
            if (ok) {
              new Notice(`已删除分组：${group.name}`);
              this.display();
            }
          })
        );
    }
  }
}

module.exports = PluginGroupTogglePlugin;
