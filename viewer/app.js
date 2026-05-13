/**
 * Flexcil Viewer - Главный модуль приложения
 */

class FlexcilViewer {
    constructor() {
        this.parser = null;
        this.renderer = null;
        this.backupLoader = null;
        this.fabParser = null;
        
        this.currentPageIndex = 0;
        this.currentDocument = null;
        
        // Режим просмотра: 'single' или 'continuous'
        this.viewMode = 'single';
        this.pageRenderers = []; // Для режима continuous
        this.currentPageData = null; // Данные текущей страницы для синхронизации
        
        // Аудио
        this.audioElement = null;
        this.audioSyncEnabled = true;
        this.audioStartTimestamp = 0;
        
        // Все аудиозаписи бэкапа (для фильтрации по документу)
        this.allRecordings = [];
        
        this.init();
    }

    async init() {
        // Инициализация рендерера
        this.renderer = new FlexcilRenderer({
            pdfCanvas: document.getElementById('pdf-canvas'),
            drawingsCanvas: document.getElementById('drawings-canvas'),
            imagesCanvas: document.getElementById('images-canvas')
        });

        this.backupLoader = new BackupLoader();
        
        // Привязка обработчиков событий
        this.bindEvents();
        
        // Информация о поддержке API
        if (!('showDirectoryPicker' in window)) {
            console.info('File System Access API not supported - using fallback file input');
        }
    }

    bindEvents() {
        // Кнопки открытия
        const openBackupBtns = [
            document.getElementById('open-backup-btn'),
            document.getElementById('welcome-open-backup')
        ];
        
        const openFileBtns = [
            document.getElementById('open-file-btn'),
            document.getElementById('welcome-open-file')
        ];

        openBackupBtns.forEach(btn => {
            if (btn) btn.addEventListener('click', () => this.openBackupFolder());
        });

        openFileBtns.forEach(btn => {
            if (btn) btn.addEventListener('click', () => this.openFlxFile());
        });

        // Навигация по страницам
        document.getElementById('prev-page').addEventListener('click', () => this.prevPage());
        document.getElementById('next-page').addEventListener('click', () => this.nextPage());

        // Зум
        document.getElementById('zoom-in').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoom-out').addEventListener('click', () => this.zoomOut());
        document.getElementById('zoom-fit').addEventListener('click', () => this.zoomFit());

        // Переключатели слоёв
        document.getElementById('show-pdf').addEventListener('change', (e) => {
            this.renderer.setLayerVisibility('pdf', e.target.checked);
            this.rerenderCurrentView();
        });
        
        document.getElementById('show-drawings').addEventListener('change', (e) => {
            this.renderer.setLayerVisibility('drawings', e.target.checked);
            this.rerenderCurrentView();
        });
        
        document.getElementById('show-images').addEventListener('change', (e) => {
            this.renderer.setLayerVisibility('images', e.target.checked);
            this.rerenderCurrentView();
        });

        // Переключение режима просмотра
        document.getElementById('toggle-view-mode').addEventListener('click', () => this.toggleViewMode());

        // Боковая панель
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
        });

        // Табы боковой панели
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // Аудио плеер
        document.getElementById('audio-play').addEventListener('click', () => this.toggleAudioPlay());
        document.getElementById('audio-prev').addEventListener('click', () => this.audioSeek(-10));
        document.getElementById('audio-next').addEventListener('click', () => this.audioSeek(10));
        document.getElementById('audio-seek').addEventListener('input', (e) => this.audioSeekTo(e.target.value));
        document.getElementById('audio-speed').addEventListener('change', (e) => this.changeAudioSpeed(e.target.value));
        document.getElementById('audio-sync-drawings').addEventListener('change', (e) => {
            this.audioSyncEnabled = e.target.checked;
            if (!this.audioSyncEnabled) {
                this.renderer.showAllObjects();
                this.rerenderCurrentView();
            }
        });

        // Модальные окна
        document.getElementById('error-close').addEventListener('click', () => {
            document.getElementById('error-modal').classList.add('hidden');
        });

        // Горячие клавиши
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }

    handleKeyDown(e) {
        switch (e.key) {
            case 'ArrowLeft':
                this.prevPage();
                break;
            case 'ArrowRight':
                this.nextPage();
                break;
            case '+':
            case '=':
                if (e.ctrlKey) {
                    e.preventDefault();
                    this.zoomIn();
                }
                break;
            case '-':
                if (e.ctrlKey) {
                    e.preventDefault();
                    this.zoomOut();
                }
                break;
            case '0':
                if (e.ctrlKey) {
                    e.preventDefault();
                    this.zoomFit();
                }
                break;
            case ' ':
                if (this.audioElement) {
                    e.preventDefault();
                    this.toggleAudioPlay();
                }
                break;
        }
    }

    switchTab(tabName) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}-tab`);
        });
    }

    showLoading(text = 'Загрузка...') {
        document.getElementById('loading-text').textContent = text;
        document.getElementById('loading-modal').classList.remove('hidden');
    }

    hideLoading() {
        document.getElementById('loading-modal').classList.add('hidden');
    }

    showError(text) {
        document.getElementById('error-text').textContent = text;
        document.getElementById('error-modal').classList.remove('hidden');
    }

    /**
     * Открытие папки бэкапа
     */
    async openBackupFolder() {
        // Проверяем поддержку File System Access API
        if ('showDirectoryPicker' in window) {
            try {
                const dirHandle = await window.showDirectoryPicker();
                this.showLoading('Сканирование папки...');
                
                const structure = await this.backupLoader.loadFromHandle(dirHandle);
                
                // Проверяем, не является ли это папкой синхронизации (содержит documents.list)
                const docListEntry = this.backupLoader.findDocumentsList(structure);
                if (docListEntry) {
                    // Это папка синхронизации
                    await this.loadSyncFolder(dirHandle, structure);
                    this.hideLoading();
                    document.getElementById('welcome-screen').classList.add('hidden');
                    return;
                }
                
                // Ищем flexcilbackup папку (обычный бэкап)
                let documentsFolder = this.backupLoader.findDocumentsFolder(structure);
                let recordingsFolder = this.backupLoader.findRecordingsFolder(structure);
                
                if (!documentsFolder) {
                    // Может быть это сама папка бэкапа
                    const backupFolder = this.backupLoader.findBackupFolder(structure);
                    if (backupFolder) {
                        // Загружаем содержимое backupFolder если нужно
                        let backupChildren = backupFolder.children;
                        if (!backupChildren && backupFolder.handle) {
                            backupChildren = await this.backupLoader.loadFolderChildren(backupFolder);
                        }
                        if (backupChildren) {
                            documentsFolder = this.backupLoader.findDocumentsFolder(backupChildren);
                            recordingsFolder = this.backupLoader.findRecordingsFolder(backupChildren);
                        }
                    }
                }

                if (documentsFolder) {
                    // Загружаем содержимое папки Documents если нужно
                    let docChildren = documentsFolder.children;
                    if (!docChildren && documentsFolder.handle) {
                        docChildren = await this.backupLoader.loadFolderChildren(documentsFolder);
                    }
                    
                    // Ищем documents.list внутри Documents для получения названий
                    const docListInDocs = this.backupLoader.findDocumentsList(docChildren || []);
                    let docsMeta = null;
                    if (docListInDocs && docListInDocs.handle) {
                        docsMeta = await this.backupLoader.parseDocumentsList(docListInDocs.handle);
                        console.log('Parsed documents.list from Documents folder:', docsMeta);
                    }
                    
                    // Если есть метаданные - строим дерево по структуре documents.list
                    if (docsMeta && docChildren) {
                        // Создаём карту UUID -> entry для flx файлов
                        const fileEntryMap = new Map();
                        const collectFlxEntries = (entries) => {
                            for (const entry of entries) {
                                if (entry.type === 'flx') {
                                    const uuid = entry.name.replace('.flx', '');
                                    fileEntryMap.set(uuid, entry);
                                } else if (entry.type === 'folder' && entry.children) {
                                    collectFlxEntries(entry.children);
                                }
                            }
                        };
                        collectFlxEntries(docChildren);
                        
                        // Строим дерево по структуре documents.list
                        const structuredTree = this.buildTreeFromDocsMetaEntries(docsMeta, fileEntryMap);
                        this.renderFileTree(structuredTree, documentsFolder.handle);
                    } else {
                        // Fallback: показываем как есть
                        this.renderFileTree(docChildren || [], documentsFolder.handle);
                    }
                    
                    // Сохраняем список аудиозаписей для фильтрации по документу
                    if (recordingsFolder) {
                        let recChildren = recordingsFolder.children;
                        if (!recChildren && recordingsFolder.handle) {
                            recChildren = await this.backupLoader.loadFolderChildren(recordingsFolder);
                        }
                        if (recChildren && recChildren.length > 0) {
                            // Сохраняем все записи, но не показываем пока
                            this.allRecordings = recChildren.filter(r => r.type === 'fab');
                            // Показываем сообщение что нужно открыть документ
                            this.showNoDocumentSelectedMessage();
                        }
                    }
                } else {
                    // Показываем всё что есть
                    this.renderFileTree(structure, dirHandle);
                }

                this.hideLoading();
                document.getElementById('welcome-screen').classList.add('hidden');
                
            } catch (e) {
                this.hideLoading();
                if (e.name !== 'AbortError') {
                    console.error('Failed to open backup folder:', e);
                    this.showError('Не удалось открыть папку: ' + e.message);
                }
            }
        } else {
            // Fallback: выбор нескольких .flx файлов через input
            this.openMultipleFlxFiles();
        }
    }

    /**
     * Загрузка папки синхронизации
     */
    async loadSyncFolder(dirHandle, structure) {
        const syncData = await this.backupLoader.loadSyncFolder(dirHandle);
        
        if (!syncData) {
            this.showError('Не удалось загрузить папку синхронизации');
            return;
        }
        
        // Рендерим дерево файлов с красивыми названиями
        this.renderSyncFileTree(syncData.documents);
        
        // Сохраняем аудиозаписи
        if (syncData.recordings && syncData.recordings.length > 0) {
            this.allRecordings = syncData.recordings;
            this.showNoDocumentSelectedMessage();
        }
    }

    /**
     * Рендеринг дерева файлов из папки синхронизации
     */
    renderSyncFileTree(documents) {
        const container = document.getElementById('file-tree');
        container.innerHTML = '';
        
        const renderEntry = (entry, parent) => {
            const item = document.createElement('div');
            item.className = `file-tree-item ${entry.type}`;
            
            const icon = this.getFileIcon(entry.type);
            const displayName = entry.displayName || entry.name;
            item.innerHTML = `${icon}<span class="name">${displayName}</span>`;
            
            if (entry.type === 'folder') {
                const children = document.createElement('div');
                children.className = 'file-tree-children';
                
                let isExpanded = false;
                
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    isExpanded = !isExpanded;
                    children.classList.toggle('collapsed', !isExpanded);
                    item.querySelector('svg').style.transform = isExpanded ? 'rotate(90deg)' : '';
                });
                
                children.classList.add('collapsed');
                parent.appendChild(item);
                parent.appendChild(children);
                
                if (entry.children) {
                    entry.children.forEach(child => renderEntry(child, children));
                }
            } else if (entry.type === 'flx') {
                item.addEventListener('click', async () => {
                    this.showLoading('Загрузка документа...');
                    try {
                        const file = await entry.handle.getFile();
                        await this.loadDocument(file, displayName + '.flx');
                        
                        document.querySelectorAll('.file-tree-item.active').forEach(el => el.classList.remove('active'));
                        item.classList.add('active');
                    } catch (e) {
                        this.showError('Не удалось загрузить документ: ' + e.message);
                    }
                    this.hideLoading();
                });
                
                parent.appendChild(item);
            } else {
                parent.appendChild(item);
            }
        };
        
        documents.forEach(entry => renderEntry(entry, container));
    }

    /**
     * Fallback: открытие нескольких .flx файлов через input
     */
    openMultipleFlxFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.webkitdirectory = true; // Попробуем выбрать папку
        
        input.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;
            
            this.showLoading('Загрузка файлов...');
            
            // Ищем documents.list для получения названий
            const docListFile = files.find(f => f.name === 'documents.list');
            let docsMeta = null;
            
            if (docListFile) {
                docsMeta = await this.parseDocumentsListFile(docListFile);
                console.log('Parsed documents.list:', docsMeta);
            }
            
            // Фильтруем .flx и .fab файлы
            const flxFiles = files.filter(f => f.name.endsWith('.flx'));
            const fabFiles = files.filter(f => f.name.endsWith('.fab'));
            
            if (flxFiles.length === 0) {
                this.hideLoading();
                this.showError('Не найдено .flx файлов');
                return;
            }
            
            // Создаём структуру дерева из файлов с учётом метаданных
            const structure = this.buildTreeFromFiles(flxFiles, docsMeta);
            this.renderFileTreeFromFiles(structure);
            
            // Сохраняем все аудиозаписи для фильтрации по документу
            if (fabFiles.length > 0) {
                this.allRecordings = fabFiles.map(f => ({
                    name: f.name,
                    type: 'fab',
                    file: f
                }));
                this.showNoDocumentSelectedMessage();
            }
            
            this.hideLoading();
            document.getElementById('welcome-screen').classList.add('hidden');
        };
        
        input.click();
    }

    /**
     * Парсинг documents.list из File объекта (для fallback)
     */
    async parseDocumentsListFile(file) {
        try {
            const buffer = await file.arrayBuffer();
            const data = new Uint8Array(buffer);
            
            if (data.length < 8) return null;
            
            // Пропускаем 8-байтный заголовок и распаковываем zlib
            const compressed = data.slice(8);
            
            // Используем pako для распаковки
            if (typeof pako === 'undefined') {
                console.warn('pako not available for decompression');
                return null;
            }
            
            const decompressed = pako.inflateRaw(compressed);
            const text = new TextDecoder().decode(decompressed);
            return JSON.parse(text);
        } catch (e) {
            console.error('Failed to parse documents.list:', e);
            return null;
        }
    }

    /**
     * Построение дерева из списка файлов с учётом структуры documents.list
     */
    buildTreeFromFiles(files, docsMeta = null) {
        // Создаём карту file UUID -> File object
        const fileMap = new Map();
        for (const file of files) {
            const uuid = file.name.replace('.flx', '');
            fileMap.set(uuid, file);
        }
        
        // Если есть documents.list - строим дерево по его структуре
        if (docsMeta) {
            return this.buildTreeFromDocsMeta(docsMeta, fileMap);
        }
        
        // Fallback: просто список файлов
        const root = [];
        for (const file of files) {
            root.push({
                name: file.name,
                displayName: file.name,
                type: 'flx',
                file: file,
                meta: null
            });
        }
        return root;
    }

    /**
     * Построение дерева из структуры documents.list
     */
    buildTreeFromDocsMeta(docsMeta, fileMap) {
        const result = [];
        
        const processItems = (items) => {
            const entries = [];
            
            for (const item of items) {
                if (item.type === 1 && item.children) {
                    // Это папка (type: 1)
                    const folderEntry = {
                        name: item.name,
                        displayName: item.name,
                        type: 'folder',
                        color: item.color,
                        children: processItems(item.children)
                    };
                    entries.push(folderEntry);
                } else if (item.document) {
                    // Это документ
                    const file = fileMap.get(item.document);
                    if (file) {
                        entries.push({
                            name: file.name,
                            displayName: item.name || file.name,
                            type: 'flx',
                            file: file,
                            meta: item
                        });
                    }
                }
            }
            
            return entries;
        };
        
        return processItems(docsMeta);
    }

    /**
     * Рендеринг дерева из файлов (fallback)
     */
    renderFileTreeFromFiles(entries) {
        const container = document.getElementById('file-tree');
        container.innerHTML = '';
        
        const renderEntry = (entry, parent) => {
            const item = document.createElement('div');
            item.className = `file-tree-item ${entry.type}`;
            
            const icon = this.getFileIcon(entry.type);
            // Используем displayName если есть, иначе name
            const name = entry.displayName || entry.name;
            item.innerHTML = `${icon}<span class="name">${name}</span>`;
            
            if (entry.type === 'folder') {
                const children = document.createElement('div');
                children.className = 'file-tree-children';
                
                let isExpanded = false;
                
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    isExpanded = !isExpanded;
                    children.classList.toggle('collapsed', !isExpanded);
                    item.querySelector('svg').style.transform = isExpanded ? 'rotate(90deg)' : '';
                });
                
                children.classList.add('collapsed');
                parent.appendChild(item);
                parent.appendChild(children);
                
                if (entry.children) {
                    entry.children.forEach(child => renderEntry(child, children));
                }
            } else if (entry.type === 'flx') {
                item.addEventListener('click', async () => {
                    this.showLoading('Загрузка документа...');
                    try {
                        await this.loadDocument(entry.file, entry.name);
                        
                        document.querySelectorAll('.file-tree-item.active').forEach(el => el.classList.remove('active'));
                        item.classList.add('active');
                    } catch (e) {
                        this.showError('Не удалось загрузить документ: ' + e.message);
                    }
                    this.hideLoading();
                });
                
                parent.appendChild(item);
            } else {
                parent.appendChild(item);
            }
        };
        
        entries.forEach(entry => renderEntry(entry, container));
    }

    /**
     * Открытие отдельного .flx файла
     */
    async openFlxFile() {
        // Проверяем поддержку File System Access API
        if ('showOpenFilePicker' in window) {
            try {
                const [fileHandle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'Flexcil Notes',
                        accept: { 'application/zip': ['.flx'] }
                    }],
                    multiple: false
                });

                this.showLoading('Загрузка документа...');
                
                const file = await fileHandle.getFile();
                await this.loadDocument(file, file.name);
                
                this.hideLoading();
                document.getElementById('welcome-screen').classList.add('hidden');
                
            } catch (e) {
                this.hideLoading();
                if (e.name !== 'AbortError') {
                    console.error('Failed to open file:', e);
                    this.showError('Не удалось открыть файл: ' + e.message);
                }
            }
        } else {
            // Fallback: используем обычный input
            this.openFlxFileFallback();
        }
    }

    /**
     * Fallback для открытия .flx файла
     */
    openFlxFileFallback() {
        console.log('Using fallback file picker');
        
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.flx';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            console.log('File selected:', file);
            
            if (!file) return;
            
            this.showLoading('Загрузка документа...');
            
            try {
                await this.loadDocument(file, file.name);
                document.getElementById('welcome-screen').classList.add('hidden');
            } catch (err) {
                console.error('Load error:', err);
                this.showError('Не удалось загрузить документ: ' + err.message);
            }
            
            this.hideLoading();
        };
        
        input.click();
    }

    /**
     * Добавление displayName из метаданных к записям
     */
    enrichEntriesWithMeta(entries, metaMap) {
        for (const entry of entries) {
            if (entry.type === 'flx') {
                const uuid = entry.name.replace('.flx', '');
                const meta = metaMap.get(uuid);
                if (meta) {
                    entry.displayName = meta.name;
                    entry.meta = meta;
                }
            } else if (entry.type === 'folder' && entry.children) {
                this.enrichEntriesWithMeta(entry.children, metaMap);
            }
        }
    }

    /**
     * Построение карты UUID → metadata из documents.list (рекурсивно)
     */
    buildMetaMap(docsMeta) {
        const metaMap = new Map();
        
        const processItems = (items) => {
            for (const item of items) {
                // Документ имеет поле 'document' с UUID
                if (item.document) {
                    metaMap.set(item.document, item);
                }
                // Папки (type: 1) имеют children
                if (item.children && Array.isArray(item.children)) {
                    processItems(item.children);
                }
            }
        };
        
        processItems(docsMeta);
        return metaMap;
    }

    /**
     * Построение дерева из documents.list для File System Access API
     */
    buildTreeFromDocsMetaEntries(docsMeta, fileEntryMap) {
        const processItems = (items) => {
            const entries = [];
            
            for (const item of items) {
                if (item.type === 1 && item.children) {
                    // Это папка (type: 1)
                    const folderEntry = {
                        name: item.name,
                        displayName: item.name,
                        type: 'folder',
                        color: item.color,
                        children: processItems(item.children)
                    };
                    entries.push(folderEntry);
                } else if (item.document) {
                    // Это документ
                    const fileEntry = fileEntryMap.get(item.document);
                    if (fileEntry) {
                        entries.push({
                            ...fileEntry,
                            displayName: item.name || fileEntry.name,
                            meta: item
                        });
                    }
                }
            }
            
            return entries;
        };
        
        return processItems(docsMeta);
    }

    /**
     * Рендеринг дерева файлов
     */
    renderFileTree(entries, parentHandle) {
        const container = document.getElementById('file-tree');
        container.innerHTML = '';
        
        const renderEntry = (entry, parent) => {
            const item = document.createElement('div');
            item.className = `file-tree-item ${entry.type}`;
            
            const icon = this.getFileIcon(entry.type);
            // Используем displayName если есть
            const displayName = entry.displayName || entry.name;
            item.innerHTML = `${icon}<span class="name">${displayName}</span>`;
            
            if (entry.type === 'folder') {
                const children = document.createElement('div');
                children.className = 'file-tree-children';
                
                let isExpanded = false;
                let childrenLoaded = false;
                let isLoading = false;
                
                item.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    
                    // Защита от двойного клика во время загрузки
                    if (isLoading) return;
                    
                    isExpanded = !isExpanded;
                    children.classList.toggle('collapsed', !isExpanded);
                    item.querySelector('svg').style.transform = isExpanded ? 'rotate(90deg)' : '';
                    
                    // Ленивая загрузка дочерних элементов
                    if (isExpanded && !childrenLoaded) {
                        isLoading = true;
                        item.classList.add('loading');
                        
                        // Даём UI обновиться перед загрузкой
                        await new Promise(r => setTimeout(r, 10));
                        
                        try {
                            if (entry.needsLoad) {
                                const loadedChildren = await this.backupLoader.loadFolderChildren(entry);
                                loadedChildren.forEach(child => renderEntry(child, children));
                            } else if (entry.children) {
                                entry.children.forEach(child => renderEntry(child, children));
                            }
                            childrenLoaded = true;
                        } finally {
                            isLoading = false;
                            item.classList.remove('loading');
                        }
                    }
                });
                
                children.classList.add('collapsed');
                parent.appendChild(item);
                parent.appendChild(children);
                
            } else if (entry.type === 'flx') {
                item.addEventListener('click', async () => {
                    this.showLoading('Загрузка документа...');
                    try {
                        const file = await entry.handle.getFile();
                        await this.loadDocument(file, entry.name);
                        
                        // Подсветка активного файла
                        document.querySelectorAll('.file-tree-item.active').forEach(el => el.classList.remove('active'));
                        item.classList.add('active');
                    } catch (e) {
                        this.showError('Не удалось загрузить документ: ' + e.message);
                    }
                    this.hideLoading();
                });
                
                parent.appendChild(item);
            } else {
                parent.appendChild(item);
            }
        };
        
        entries.forEach(entry => renderEntry(entry, container));
    }

    getFileIcon(type) {
        switch (type) {
            case 'folder':
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>`;
            case 'flx':
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>`;
            default:
                return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>`;
        }
    }

    /**
     * Загрузка документа
     */
    async loadDocument(file, name) {
        this.parser = new FlxParser();
        await this.parser.loadFile(file);
        
        this.currentDocument = name.replace('.flx', '');
        document.getElementById('doc-title').textContent = this.parser.documentName;
        
        // Сброс состояния
        this.currentPageIndex = 0;
        this.renderer.clearCache();
        
        // Включаем элементы управления
        this.enableControls();
        
        // Рендерим список страниц
        await this.renderPageList();
        
        // Рендерим первую страницу
        await this.renderCurrentPage();
        
        // Загружаем связанные аудиозаписи
        await this.loadDocumentAudioRecordings();
        
        // Показываем контейнер страницы
        document.getElementById('page-wrapper').style.display = 'block';
        document.getElementById('welcome-screen').classList.add('hidden');
    }

    /**
     * Загрузка аудиозаписей связанных с текущим документом
     */
    async loadDocumentAudioRecordings() {
        const audioIds = this.parser.getAudioRecordIds();
        
        if (audioIds.length === 0) {
            this.showNoAudioMessage();
            return;
        }
        
        // Находим FAB файлы по ID
        const matchingRecordings = this.allRecordings.filter(rec => {
            const recId = rec.name.replace('.fab', '');
            return audioIds.includes(recId);
        });
        
        if (matchingRecordings.length > 0) {
            await this.loadRecordingsList(matchingRecordings);
        } else {
            this.showNoAudioMessage();
        }
    }

    /**
     * Показать сообщение об отсутствии аудиозаписей
     */
    showNoAudioMessage() {
        const container = document.getElementById('audio-list');
        container.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
                <p>Нет аудиозаписей для этого документа</p>
            </div>
        `;
    }

    /**
     * Показать сообщение что документ не выбран
     */
    showNoDocumentSelectedMessage() {
        const container = document.getElementById('audio-list');
        container.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <p>Откройте документ, чтобы увидеть связанные аудиозаписи</p>
            </div>
        `;
    }

    enableControls() {
        document.getElementById('prev-page').disabled = false;
        document.getElementById('next-page').disabled = false;
        document.getElementById('zoom-in').disabled = false;
        document.getElementById('zoom-out').disabled = false;
        document.getElementById('zoom-fit').disabled = false;
        document.getElementById('toggle-view-mode').disabled = false;
    }

    /**
     * Рендеринг списка страниц
     */
    async renderPageList() {
        const container = document.getElementById('page-list');
        container.innerHTML = '';
        
        // Не загружаем превью - только номера страниц
        for (let i = 0; i < this.parser.pageCount; i++) {
            const thumbnail = document.createElement('div');
            thumbnail.className = 'page-thumbnail';
            if (i === this.currentPageIndex) thumbnail.classList.add('active');
            
            const pageNum = document.createElement('span');
            pageNum.className = 'page-number';
            pageNum.textContent = i + 1;
            thumbnail.appendChild(pageNum);
            
            thumbnail.addEventListener('click', () => {
                this.goToPage(i);
            });
            
            container.appendChild(thumbnail);
        }
    }

    /**
     * Рендеринг текущей страницы
     */
    async renderCurrentPage() {
        if (!this.parser) {
            return;
        }
        
        const pageInfo = this.parser.getPageInfo(this.currentPageIndex);
        
        if (!pageInfo) {
            return;
        }
        
        const pageData = await this.parser.getPageData(pageInfo.key);
        
        // Сохраняем данные для синхронизации аудио
        this.currentPageData = pageData;
        
        await this.renderer.renderPage(pageInfo, pageData, this.parser);
        
        // Обновляем индикатор
        document.getElementById('page-indicator').textContent = 
            `${this.currentPageIndex + 1} / ${this.parser.pageCount}`;
        
        // Обновляем активную миниатюру
        document.querySelectorAll('.page-thumbnail').forEach((thumb, i) => {
            thumb.classList.toggle('active', i === this.currentPageIndex);
        });
        
        // Обновляем состояние кнопок навигации
        document.getElementById('prev-page').disabled = this.currentPageIndex === 0;
        document.getElementById('next-page').disabled = this.currentPageIndex >= this.parser.pageCount - 1;
    }

    async rerenderPage() {
        await this.renderCurrentPage();
    }

    async rerenderCurrentView() {
        if (this.viewMode === 'continuous') {
            await this.renderContinuousMode();
        } else {
            await this.rerenderPage();
        }
    }

    goToPage(index) {
        if (index < 0 || index >= this.parser.pageCount) return;
        this.currentPageIndex = index;
        
        if (this.viewMode === 'continuous') {
            // Скроллим к нужной странице
            const wrapper = document.querySelector(`.continuous-page-wrapper[data-page-index="${index}"]`);
            if (wrapper) {
                wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } else {
            this.renderCurrentPage();
        }
    }

    prevPage() {
        this.goToPage(this.currentPageIndex - 1);
    }

    nextPage() {
        this.goToPage(this.currentPageIndex + 1);
    }

    zoomIn() {
        this.renderer.setZoom(this.renderer.zoom * 1.25);
        this.updateZoomDisplay();
        if (this.viewMode === 'continuous') {
            this.renderContinuousMode();
        } else {
            this.rerenderPage();
        }
    }

    zoomOut() {
        this.renderer.setZoom(this.renderer.zoom / 1.25);
        this.updateZoomDisplay();
        if (this.viewMode === 'continuous') {
            this.renderContinuousMode();
        } else {
            this.rerenderPage();
        }
    }

    zoomFit() {
        this.renderer.setZoom(1.0);
        this.updateZoomDisplay();
        if (this.viewMode === 'continuous') {
            this.renderContinuousMode();
        } else {
            this.rerenderPage();
        }
    }

    updateZoomDisplay() {
        document.getElementById('zoom-level').textContent = 
            Math.round(this.renderer.zoom * 100) + '%';
    }

    /**
     * Переключение режима просмотра
     */
    toggleViewMode() {
        this.viewMode = this.viewMode === 'single' ? 'continuous' : 'single';
        
        const btn = document.getElementById('toggle-view-mode');
        const pageWrapper = document.getElementById('page-wrapper');
        const pagesContinuous = document.getElementById('pages-continuous');
        const prevBtn = document.getElementById('prev-page');
        const nextBtn = document.getElementById('next-page');
        const pageIndicator = document.getElementById('page-indicator');
        
        if (this.viewMode === 'continuous') {
            btn.title = 'Постраничный режим';
            btn.classList.add('active');
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="6" y="3" width="12" height="18" rx="2"/>
                </svg>
            `;
            pageWrapper.style.display = 'none';
            pagesContinuous.classList.remove('hidden');
            prevBtn.style.display = 'none';
            nextBtn.style.display = 'none';
            pageIndicator.style.display = 'none';
            
            this.renderContinuousMode();
        } else {
            btn.title = 'Непрерывный режим';
            btn.classList.remove('active');
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="3" y1="15" x2="21" y2="15"/>
                </svg>
            `;
            pagesContinuous.classList.add('hidden');
            pagesContinuous.innerHTML = '';
            pageWrapper.style.display = 'block';
            prevBtn.style.display = '';
            nextBtn.style.display = '';
            pageIndicator.style.display = '';
            
            this.renderCurrentPage();
        }
    }

    /**
     * Рендеринг всех страниц в режиме непрерывного скролла
     */
    async renderContinuousMode() {
        if (!this.parser) return;
        
        const container = document.getElementById('pages-continuous');
        container.innerHTML = '';
        
        const pageCount = this.parser.pageCount;
        const zoom = this.renderer.zoom;
        
        for (let i = 0; i < pageCount; i++) {
            const pageInfo = this.parser.getPageInfo(i);
            if (!pageInfo) continue;
            
            const pageData = await this.parser.getPageData(pageInfo.key);
            
            // Создаём обёртку для страницы
            const wrapper = document.createElement('div');
            wrapper.className = 'continuous-page-wrapper';
            wrapper.dataset.pageIndex = i;
            
            // Вычисляем размеры страницы
            const baseWidth = 768;
            const baseHeight = 1024;
            const pageHeight = pageInfo.contentHeight || baseHeight;
            
            const width = Math.round(baseWidth * zoom);
            const height = Math.round(pageHeight * zoom);
            
            wrapper.style.width = `${width}px`;
            wrapper.style.height = `${height}px`;
            
            // Создаём канвасы
            const pdfCanvas = document.createElement('canvas');
            const drawingsCanvas = document.createElement('canvas');
            const imagesCanvas = document.createElement('canvas');
            
            pdfCanvas.width = width;
            pdfCanvas.height = height;
            drawingsCanvas.width = width;
            drawingsCanvas.height = height;
            imagesCanvas.width = width;
            imagesCanvas.height = height;
            
            drawingsCanvas.style.pointerEvents = 'none';
            imagesCanvas.style.pointerEvents = 'none';
            
            wrapper.appendChild(pdfCanvas);
            wrapper.appendChild(drawingsCanvas);
            wrapper.appendChild(imagesCanvas);
            
            container.appendChild(wrapper);
            
            // Рендерим страницу
            await this.renderPageToCanvases(pageInfo, pageData, pdfCanvas, drawingsCanvas, imagesCanvas);
        }
    }

    /**
     * Рендеринг страницы на указанные канвасы
     */
    async renderPageToCanvases(pageInfo, pageData, pdfCanvas, drawingsCanvas, imagesCanvas) {
        const zoom = this.renderer.zoom;
        const baseWidth = 768;
        const baseHeight = 1024;
        const pageHeight = pageInfo.contentHeight || baseHeight;
        
        const width = pdfCanvas.width;
        const height = pdfCanvas.height;
        
        // Рендерим PDF
        if (this.renderer.showPdf && pageData.pdfBlob) {
            try {
                const pdfDoc = await pdfjsLib.getDocument(pageData.pdfBlob).promise;
                const page = await pdfDoc.getPage(pageInfo.pdfPageNum || 1);
                
                const viewport = page.getViewport({ scale: 1 });
                const scale = width / viewport.width;
                const scaledViewport = page.getViewport({ scale });
                
                const ctx = pdfCanvas.getContext('2d');
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
                
                await page.render({
                    canvasContext: ctx,
                    viewport: scaledViewport
                }).promise;
            } catch (e) {
                console.warn('PDF render error:', e);
            }
        } else {
            const ctx = pdfCanvas.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, width, height);
        }
        
        // Рендерим рисунки
        if (this.renderer.showDrawings && pageData.drawings?.length > 0) {
            const ctx = drawingsCanvas.getContext('2d');
            ctx.clearRect(0, 0, width, height);
            
            for (const drawing of pageData.drawings) {
                const drawingKey = drawing.key || drawing.objectKey;
                if (!this.renderer.allObjectsVisible && !this.renderer.visibleObjects.has(drawingKey)) {
                    continue;
                }
                
                const points = drawing.decodedPoints || drawing.points || [];
                if (points.length < 2) continue;
                
                ctx.beginPath();
                ctx.strokeStyle = drawing.color?.css || drawing.color || 'rgba(0, 0, 0, 0.8)';
                ctx.lineWidth = (drawing.thickness || 2) * zoom;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                
                const startX = (drawing.start?.x || 0) * baseWidth * zoom;
                const startY = (drawing.start?.y || 0) * baseHeight * zoom;
                
                ctx.moveTo(startX + points[0].x * baseWidth * zoom, 
                          startY + points[0].y * baseHeight * zoom);
                
                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(startX + points[i].x * baseWidth * zoom,
                              startY + points[i].y * baseHeight * zoom);
                }
                
                ctx.stroke();
            }
        }
        
        // Рендерим изображения
        if (this.renderer.showImages && pageData.images?.length > 0) {
            const ctx = imagesCanvas.getContext('2d');
            ctx.clearRect(0, 0, width, height);
            
            for (const imgInfo of pageData.images) {
                try {
                    const imgBlob = await this.parser.getImageBlob(imgInfo.key || imgInfo.attachmentKey);
                    if (!imgBlob) continue;
                    
                    const url = URL.createObjectURL(imgBlob);
                    try {
                        const img = await this.renderer.loadImage(url);
                        
                        const x = (imgInfo.origin?.x || 0) * baseWidth * zoom;
                        const y = (imgInfo.origin?.y || 0) * baseHeight * zoom;
                        const w = (imgInfo.size?.width || 0.2) * baseWidth * zoom;
                        const h = (imgInfo.size?.height || 0.2) * baseHeight * zoom;
                        
                        ctx.drawImage(img, x, y, w, h);
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                } catch (e) {
                    console.warn('Image render error:', e);
                }
            }
        }
    }

    /**
     * Загрузка списка аудиозаписей
     */
    async loadRecordingsList(recordings) {
        const container = document.getElementById('audio-list');
        container.innerHTML = '';
        
        // Фильтруем только .fab файлы если нужно
        const fabFiles = recordings.filter(r => r.type === 'fab' || r.name?.endsWith('.fab'));
        
        if (fabFiles.length === 0) {
            this.showNoAudioMessage();
            return;
        }
        
        // Показываем список без парсинга - только имена файлов
        for (const fab of fabFiles) {
            const item = document.createElement('div');
            item.className = 'audio-item';
            
            // Показываем имя файла как временное имя
            const displayName = fab.name.replace('.fab', '');
            item.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </svg>
                <span class="audio-name">${displayName}</span>
                <span class="audio-duration"></span>
            `;
            
            item.addEventListener('click', async () => {
                try {
                    item.classList.add('loading');
                    
                    // Поддержка и handle и file
                    const file = fab.handle ? await fab.handle.getFile() : fab.file;
                    const fabParser = new FabParser();
                    await fabParser.loadFile(file);
                    
                    // Обновляем имя и длительность после загрузки
                    item.querySelector('.audio-name').textContent = fabParser.name || displayName;
                    item.querySelector('.audio-duration').textContent = this.formatDuration(fabParser.duration);
                    
                    await this.loadAudioFromParser(fabParser);
                    
                    document.querySelectorAll('.audio-item.active').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                } catch (e) {
                    console.error('Failed to load FAB:', e);
                } finally {
                    item.classList.remove('loading');
                }
            });
            
            container.appendChild(item);
        }
    }

    /**
     * Загрузка аудио из fabParser (без fileHandle)
     */
    async loadAudioFromParser(fabParser) {
        const audioBlob = await fabParser.getAudio();
        if (!audioBlob) return;
        
        this.fabParser = fabParser;
        this.audioStartTimestamp = fabParser.info?.start || 0;
        
        if (this.audioElement) {
            this.audioElement.pause();
            URL.revokeObjectURL(this.audioElement.src);
        }
        
        this.audioElement = new Audio();
        this.audioElement.src = URL.createObjectURL(audioBlob);
        
        this.audioElement.addEventListener('timeupdate', () => this.onAudioTimeUpdate());
        this.audioElement.addEventListener('loadedmetadata', () => {
            document.getElementById('audio-time').textContent = 
                `0:00 / ${this.formatDuration(this.audioElement.duration)}`;
        });
        
        document.getElementById('audio-player').classList.remove('hidden');
        document.getElementById('audio-title').textContent = fabParser.name;
    }

    /**
     * Загрузка аудио
     */
    async loadAudio(fileHandle, fabParser) {
        const audioBlob = await fabParser.getAudio();
        if (!audioBlob) return;
        
        this.fabParser = fabParser;
        this.audioStartTimestamp = fabParser.info?.start || 0;
        
        if (this.audioElement) {
            this.audioElement.pause();
            URL.revokeObjectURL(this.audioElement.src);
        }
        
        this.audioElement = new Audio();
        this.audioElement.src = URL.createObjectURL(audioBlob);
        
        this.audioElement.addEventListener('timeupdate', () => this.onAudioTimeUpdate());
        this.audioElement.addEventListener('loadedmetadata', () => {
            document.getElementById('audio-time').textContent = 
                `0:00 / ${this.formatDuration(this.audioElement.duration)}`;
        });
        
        document.getElementById('audio-player').classList.remove('hidden');
        document.getElementById('audio-title').textContent = fabParser.name;
    }

    formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    toggleAudioPlay() {
        if (!this.audioElement) return;
        
        if (this.audioElement.paused) {
            this.audioElement.play();
            document.getElementById('audio-play').innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                </svg>
            `;
        } else {
            this.audioElement.pause();
            document.getElementById('audio-play').innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
            `;
        }
    }

    audioSeek(delta) {
        if (!this.audioElement) return;
        this.audioElement.currentTime = Math.max(0, this.audioElement.currentTime + delta);
    }

    audioSeekTo(percent) {
        if (!this.audioElement) return;
        this.audioElement.currentTime = (percent / 100) * this.audioElement.duration;
    }

    onAudioTimeUpdate() {
        if (!this.audioElement) return;
        
        const current = this.audioElement.currentTime;
        const total = this.audioElement.duration;
        
        document.getElementById('audio-time').textContent = 
            `${this.formatDuration(current)} / ${this.formatDuration(total)}`;
        document.getElementById('audio-seek').value = (current / total) * 100;
        
        // Синхронизация с рисунками (без полной перерисовки)
        if (this.audioSyncEnabled && this.fabParser && this.currentPageData) {
            const currentTimestamp = this.audioStartTimestamp + current;
            const objects = this.fabParser.getObjectsAtTime(currentTimestamp);
            
            const visibleKeys = new Set(objects.map(o => o.objectKey));
            this.renderer.setVisibleObjects(visibleKeys);
            
            // Перерисовываем только рисунки и изображения, не PDF
            this.renderer.renderDrawings(this.currentPageData.drawings);
            this.renderer.renderImages(this.currentPageData.images, this.parser);
        }
    }

    changeAudioSpeed(speed) {
        if (!this.audioElement) return;
        this.audioElement.playbackRate = parseFloat(speed);
    }
}

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    window.viewer = new FlexcilViewer();
});
