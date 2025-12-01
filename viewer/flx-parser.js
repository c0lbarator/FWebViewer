/**
 * FlxParser - Парсер формата Flexcil (.flx)
 * 
 * Структура .flx файла (ZIP архив):
 * - info: JSON с метаданными документа
 * - pages.index: JSON с информацией о страницах
 * - attachment/PDF/: PDF фоны
 * - attachment/image/: Вставленные изображения
 * - objects/<pageKey>.drawings: Рисунки страницы
 * - objects/<pageKey>.images: Метаданные изображений на странице
 * - objects/<pageKey>.objects: Список объектов страницы
 * - thumbnail, thumbnail@2x, thumbnail@3x: Превью документа
 * - audiorecord.refs: Ссылки на аудиозаписи
 */

class FlxParser {
    constructor() {
        this.zip = null;
        this.info = null;
        this.pagesIndex = null;
        this.attachments = new Map();
        this.pageObjects = new Map();
        this.wasmReady = false;
    }

    /**
     * Инициализация WASM модуля для декодирования точек
     */
    async initWasm() {
        if (this.wasmReady) return;
        
        try {
            const go = new Go();
            const result = await WebAssembly.instantiateStreaming(
                fetch('flexcil.wasm'),
                go.importObject
            );
            go.run(result.instance);
            this.wasmReady = true;
            console.log('WASM module initialized');
        } catch (error) {
            console.warn('WASM initialization failed, using JS fallback:', error);
            this.wasmReady = false;
        }
    }

    /**
     * Загрузка .flx файла
     * @param {ArrayBuffer|Blob|File} data - Данные файла
     * @returns {Promise<Object>} - Распарсенный документ
     */
    async loadFile(data) {
        // Не инициализируем WASM сразу - сделаем позже по необходимости
        // await this.initWasm();
        
        this.zip = await JSZip.loadAsync(data);
        
        // Парсим только основные метаданные (маленькие JSON файлы)
        this.info = await this.parseJson('info');
        this.pagesIndex = await this.parseJson('pages.index');
        
        // Загружаем ссылки на аудиозаписи
        this.audioRefs = await this.parseJson('audiorecord.refs');
        
        return {
            info: this.info,
            pages: this.pagesIndex,
            audioRefs: this.audioRefs
        };
    }

    /**
     * Получить список ID аудиозаписей для этого документа
     * @returns {Array<string>} - массив ID (имена .fab файлов без расширения)
     */
    getAudioRecordIds() {
        if (this.audioRefs && this.audioRefs.refs) {
            return this.audioRefs.refs;
        }
        return [];
    }

    /**
     * Парсинг JSON файла из архива
     */
    async parseJson(path) {
        // Пробуем оба варианта - с / и без
        let file = this.zip.file(path);
        if (!file) {
            file = this.zip.file('/' + path);
        }
        if (!file) return null;
        
        try {
            const text = await file.async('text');
            return JSON.parse(text);
        } catch (e) {
            console.warn(`Failed to parse ${path}:`, e);
            return null;
        }
    }

    /**
     * Получение PDF файла
     * @param {string} attachmentId - ID вложения
     * @returns {Promise<ArrayBuffer>}
     */
    async getPdf(attachmentId) {
        const path = `attachment/PDF/${attachmentId}`;
        let file = this.zip.file(path);
        if (!file) {
            file = this.zip.file('/' + path);
        }
        if (!file) return null;
        
        return await file.async('arraybuffer');
    }

    /**
     * Получение изображения
     * @param {string} imageId - ID изображения
     * @returns {Promise<Blob>}
     */
    async getImage(imageId) {
        const path = `attachment/image/${imageId}`;
        let file = this.zip.file(path);
        if (!file) {
            file = this.zip.file('/' + path);
        }
        if (!file) return null;
        
        const data = await file.async('arraybuffer');
        return new Blob([data], { type: 'image/png' });
    }

    /**
     * Получение превью документа
     * @param {number} scale - Масштаб (1, 2, или 3)
     * @returns {Promise<Blob>}
     */
    async getThumbnail(scale = 1) {
        const suffix = scale > 1 ? `@${scale}x` : '';
        const path = `thumbnail${suffix}`;
        let file = this.zip.file(path);
        if (!file) {
            file = this.zip.file('/' + path);
        }
        if (!file) return null;
        
        const data = await file.async('arraybuffer');
        return new Blob([data], { type: 'image/jpeg' });
    }

    /**
     * Получение данных страницы
     * @param {string} pageKey - Ключ страницы
     * @returns {Promise<Object>} - Данные страницы с рисунками и изображениями
     */
    async getPageData(pageKey) {
        // Кэширование
        if (this.pageObjects.has(pageKey)) {
            return this.pageObjects.get(pageKey);
        }

        const basePath = `objects/${pageKey}`;
        
        // Загружаем все файлы страницы параллельно
        const [drawings, images, objects] = await Promise.all([
            this.parseJson(`${basePath}.drawings`),
            this.parseJson(`${basePath}.images`),
            this.parseJson(`${basePath}.objects`)
        ]);

        // Декодируем точки рисунков
        const decodedDrawings = drawings ? await this.decodeDrawings(drawings) : [];
        
        const pageData = {
            drawings: decodedDrawings,
            images: images || [],
            objects: objects || [],
            pageKey
        };

        this.pageObjects.set(pageKey, pageData);
        return pageData;
    }

    /**
     * Декодирование рисунков (асинхронно, чтобы не блокировать UI)
     * @param {Array} drawings - Массив рисунков
     * @returns {Promise<Array>}
     */
    async decodeDrawings(drawings) {
        if (!drawings || !Array.isArray(drawings)) return [];

        const result = [];
        const chunkSize = 50; // Обрабатываем по 50 рисунков за раз
        
        for (let i = 0; i < drawings.length; i += chunkSize) {
            const chunk = drawings.slice(i, i + chunkSize);
            
            for (const drawing of chunk) {
                const decoded = this.decodePoints(drawing.points);
                
                result.push({
                    ...drawing,
                    decodedPoints: decoded.points,
                    pointCount: decoded.count,
                    color: this.parseColor(drawing.strokeColor),
                    fillColor: drawing.fillColor ? this.parseColor(drawing.fillColor) : null
                });
            }
            
            // Даём браузеру "дышать" между чанками
            if (i + chunkSize < drawings.length) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        
        return result;
    }

    /**
     * Декодирование Base64 точек
     * @param {string} base64Data - Base64 строка
     * @returns {Object} - {points: [], count: number}
     */
    decodePoints(base64Data) {
        if (!base64Data) return { points: [], count: 0 };

        // Используем WASM если доступен
        if (this.wasmReady && typeof FlexcilWasm !== 'undefined') {
            try {
                return FlexcilWasm.decodePoints(base64Data);
            } catch (e) {
                console.warn('WASM decode failed, using JS fallback:', e);
            }
        }

        // JavaScript fallback
        return this.decodePointsJS(base64Data);
    }

    /**
     * JavaScript fallback для декодирования точек
     */
    decodePointsJS(base64Data) {
        try {
            // Декодируем Base64
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            if (bytes.length < 4) {
                return { points: [], count: 0 };
            }

            // Первые 4 байта - количество точек (uint32 little-endian)
            const dataView = new DataView(bytes.buffer);
            const pointCount = dataView.getUint32(0, true);
            const points = [];
            
            // Каждая точка - 12 байт (2x float32 + uint32)
            let offset = 4; // Начинаем после заголовка
            const bytesPerPoint = 12;

            for (let i = 0; i < pointCount && offset + bytesPerPoint <= bytes.length; i++) {
                const x = dataView.getFloat32(offset, true);
                const y = dataView.getFloat32(offset + 4, true);
                const flags = dataView.getUint32(offset + 8, true);
                
                if (!isNaN(x) && !isNaN(y)) {
                    points.push({ x, y, pressure: 1.0, flags });
                }
                
                offset += bytesPerPoint;
            }

            return { points, count: points.length };
        } catch (e) {
            console.error('Points decode error:', e);
            return { points: [], count: 0 };
        }
    }

    /**
     * Парсинг цвета из формата ARGB int
     * @param {number} colorInt - Цвет в формате ARGB
     * @returns {Object} - {r, g, b, a, css}
     */
    parseColor(colorInt) {
        if (!colorInt && colorInt !== 0) return { r: 0, g: 0, b: 0, a: 1, css: 'rgba(0,0,0,1)' };

        // Flexcil использует ARGB формат
        const a = ((colorInt >>> 24) & 0xFF) / 255;
        const r = (colorInt >>> 16) & 0xFF;
        const g = (colorInt >>> 8) & 0xFF;
        const b = colorInt & 0xFF;

        return {
            r, g, b, a,
            css: `rgba(${r},${g},${b},${a})`
        };
    }

    /**
     * Получение информации о странице по индексу
     * @param {number} index - Индекс страницы
     * @returns {Object|null}
     */
    getPageInfo(index) {
        if (!this.pagesIndex || index < 0 || index >= this.pagesIndex.length) {
            return null;
        }
        return this.pagesIndex[index];
    }

    /**
     * Получение количества страниц
     * @returns {number}
     */
    get pageCount() {
        return this.pagesIndex ? this.pagesIndex.length : 0;
    }

    /**
     * Получение имени документа
     * @returns {string}
     */
    get documentName() {
        return this.info?.name || 'Untitled';
    }

    /**
     * Получение типа документа
     * @returns {number}
     */
    get documentType() {
        return this.info?.type || 0;
    }
}

/**
 * FabParser - Парсер формата аудиозаписей Flexcil (.fab)
 * 
 * Структура .fab файла (ZIP архив):
 * - <id>.flxa: Аудио файл (MP4/AAC)
 * - <id>.rinfo: JSON с метаданными записи
 * - <id>.rsync: JSON с синхронизацией рисунков
 */
class FabParser {
    constructor() {
        this.zip = null;
        this.info = null;
        this.syncData = null;
        this.audioId = null;
    }

    /**
     * Загрузка .fab файла
     * @param {ArrayBuffer|Blob|File} data - Данные файла
     * @returns {Promise<Object>}
     */
    async loadFile(data) {
        this.zip = await JSZip.loadAsync(data);
        
        // Находим ID записи из имён файлов
        const files = Object.keys(this.zip.files);
        const rinfoFile = files.find(f => f.endsWith('.rinfo'));
        
        if (rinfoFile) {
            this.audioId = rinfoFile.replace('.rinfo', '');
        }

        // Парсим метаданные
        if (this.audioId) {
            this.info = await this.parseJson(`${this.audioId}.rinfo`);
            this.syncData = await this.parseJson(`${this.audioId}.rsync`);
        }

        return {
            id: this.audioId,
            info: this.info,
            sync: this.syncData
        };
    }

    /**
     * Парсинг JSON файла
     */
    async parseJson(path) {
        const file = this.zip.file(path);
        if (!file) return null;
        
        try {
            const text = await file.async('text');
            return JSON.parse(text);
        } catch (e) {
            console.warn(`Failed to parse ${path}:`, e);
            return null;
        }
    }

    /**
     * Получение аудио файла
     * @returns {Promise<Blob>}
     */
    async getAudio() {
        if (!this.audioId) return null;
        
        const path = `${this.audioId}.flxa`;
        const file = this.zip.file(path);
        if (!file) return null;
        
        const data = await file.async('arraybuffer');
        return new Blob([data], { type: 'audio/mp4' });
    }

    /**
     * Получение имени записи
     * @returns {string}
     */
    get name() {
        return this.info?.name || 'Audio';
    }

    /**
     * Получение длительности в секундах
     * @returns {number}
     */
    get duration() {
        return this.info?.duration || 0;
    }

    /**
     * Получение синхронизированных объектов для времени
     * @param {number} timestamp - Unix timestamp
     * @returns {Array} - Массив ключей объектов
     */
    getObjectsAtTime(timestamp) {
        if (!this.syncData?.items) return [];
        
        return this.syncData.items
            .filter(item => item.addtime <= timestamp)
            .map(item => ({
                pageKey: item.pagekey,
                objectKey: item.obj,
                docKey: item.dockey,
                addTime: item.addtime
            }));
    }
}

/**
 * BackupLoader - Загрузчик папки бэкапа Flexcil
 */
class BackupLoader {
    constructor() {
        this.documents = new Map();
        this.recordings = new Map();
        this.structure = null;
    }

    /**
     * Загрузка папки бэкапа через File System Access API
     * @param {FileSystemDirectoryHandle} dirHandle - Handle директории
     * @returns {Promise<Object>} - Структура бэкапа
     */
    async loadFromHandle(dirHandle) {
        this.structure = await this.scanDirectory(dirHandle);
        return this.structure;
    }

    /**
     * Рекурсивное сканирование директории
     * @param {FileSystemDirectoryHandle} dirHandle
     * @param {string} path
     * @param {number} depth - глубина сканирования (0 = только текущий уровень)
     */
    async scanDirectory(dirHandle, path = '', depth = 1) {
        const entries = [];
        
        for await (const [name, handle] of dirHandle.entries()) {
            const entryPath = path ? `${path}/${name}` : name;
            
            if (handle.kind === 'directory') {
                // Всегда помечаем папки как требующие загрузки
                // Загружаем детей только если depth > 0
                let children = null;
                let needsLoad = true;
                
                if (depth > 0) {
                    children = await this.scanDirectory(handle, entryPath, 0);
                    needsLoad = false;
                }
                
                entries.push({
                    name,
                    path: entryPath,
                    type: 'folder',
                    handle,
                    children,
                    needsLoad
                });
            } else {
                const isFlx = name.endsWith('.flx');
                const isFab = name.endsWith('.fab');
                
                entries.push({
                    name,
                    path: entryPath,
                    type: isFlx ? 'flx' : (isFab ? 'fab' : 'file'),
                    handle
                });
            }
        }
        
        // Сортировка: папки сначала, затем по имени
        entries.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name, 'ru');
        });
        
        return entries;
    }

    /**
     * Загрузка дочерних элементов папки (ленивая загрузка)
     */
    async loadFolderChildren(folderEntry) {
        if (!folderEntry.needsLoad || !folderEntry.handle) {
            return folderEntry.children || [];
        }
        
        // Загружаем только текущий уровень (depth=0)
        folderEntry.children = await this.scanDirectory(folderEntry.handle, folderEntry.path, 0);
        folderEntry.needsLoad = false;
        return folderEntry.children;
    }

    /**
     * Загрузка .flx файла по handle
     * @param {FileSystemFileHandle} fileHandle
     * @returns {Promise<FlxParser>}
     */
    async loadFlxFile(fileHandle) {
        const file = await fileHandle.getFile();
        const parser = new FlxParser();
        await parser.loadFile(file);
        return parser;
    }

    /**
     * Загрузка .fab файла по handle
     * @param {FileSystemFileHandle} fileHandle
     * @returns {Promise<FabParser>}
     */
    async loadFabFile(fileHandle) {
        const file = await fileHandle.getFile();
        const parser = new FabParser();
        await parser.loadFile(file);
        return parser;
    }

    /**
     * Поиск flexcilbackup папки
     */
    findBackupFolder(entries) {
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name === 'flexcilbackup') {
                return entry;
            }
            if (entry.children) {
                const found = this.findBackupFolder(entry.children);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Поиск папки Documents
     */
    findDocumentsFolder(entries) {
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name === 'Documents') {
                return entry;
            }
            if (entry.children) {
                const found = this.findDocumentsFolder(entry.children);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Поиск папки Recordings
     */
    findRecordingsFolder(entries) {
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name === 'Recordings') {
                return entry;
            }
            if (entry.children) {
                const found = this.findRecordingsFolder(entry.children);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Проверка, является ли папка папкой синхронизации (содержит documents.list)
     */
    findDocumentsList(entries) {
        for (const entry of entries) {
            if (entry.type === 'file' && entry.name === 'documents.list') {
                return entry;
            }
        }
        return null;
    }

    /**
     * Парсинг documents.list (8 байт заголовка + zlib-сжатый JSON)
     */
    async parseDocumentsList(fileHandle) {
        try {
            const file = await fileHandle.getFile();
            const buffer = await file.arrayBuffer();
            const data = new Uint8Array(buffer);
            
            if (data.length < 8) return null;
            
            // Пропускаем 8-байтный заголовок и распаковываем zlib
            const compressed = data.slice(8);
            const decompressed = this.inflateRaw(compressed);
            
            if (!decompressed) return null;
            
            const text = new TextDecoder().decode(decompressed);
            return JSON.parse(text);
        } catch (e) {
            console.error('Failed to parse documents.list:', e);
            return null;
        }
    }

    /**
     * Raw inflate (zlib decompress without header)
     */
    inflateRaw(data) {
        try {
            // Используем pako если доступен
            if (typeof pako !== 'undefined') {
                return pako.inflateRaw(data);
            }
            
            // Fallback: DecompressionStream API (современные браузеры)
            // Не работает для raw deflate, нужен pako
            console.warn('pako not available, cannot decompress documents.list');
            return null;
        } catch (e) {
            console.error('Inflate error:', e);
            return null;
        }
    }

    /**
     * Загрузка папки синхронизации
     * @param {FileSystemDirectoryHandle} dirHandle
     * @returns {Promise<Object>} - структура с документами и их метаданными
     */
    async loadSyncFolder(dirHandle) {
        const entries = await this.scanDirectory(dirHandle, '', 0);
        
        // Ищем documents.list
        const docListEntry = this.findDocumentsList(entries);
        if (!docListEntry) return null;
        
        // Парсим метаданные документов
        const docsMeta = await this.parseDocumentsList(docListEntry.handle);
        if (!docsMeta) return null;
        
        // Создаём карту document UUID -> metadata (рекурсивно)
        const metaMap = new Map();
        const processItems = (items) => {
            for (const item of items) {
                if (item.document) {
                    metaMap.set(item.document, item);
                }
                if (item.children && Array.isArray(item.children)) {
                    processItems(item.children);
                }
            }
        };
        processItems(docsMeta);
        
        // Находим .flx и .fab файлы
        const flxFiles = entries.filter(e => e.type === 'flx');
        const fabFiles = entries.filter(e => e.type === 'fab');
        
        // Создаём карту UUID -> entry
        const fileEntryMap = new Map();
        for (const flx of flxFiles) {
            const uuid = flx.name.replace('.flx', '');
            fileEntryMap.set(uuid, flx);
        }
        
        // Строим дерево по структуре documents.list
        const buildTree = (items) => {
            const result = [];
            for (const item of items) {
                if (item.type === 1 && item.children) {
                    // Папка
                    result.push({
                        name: item.name,
                        displayName: item.name,
                        type: 'folder',
                        color: item.color,
                        children: buildTree(item.children)
                    });
                } else if (item.document) {
                    // Документ
                    const flxEntry = fileEntryMap.get(item.document);
                    if (flxEntry) {
                        result.push({
                            ...flxEntry,
                            displayName: item.name || flxEntry.name.replace('.flx', ''),
                            meta: item
                        });
                    }
                }
            }
            return result;
        };
        
        const documents = buildTree(docsMeta);
        
        return {
            type: 'sync',
            documents,
            recordings: fabFiles,
            metadata: docsMeta
        };
    }
}

// Экспорт для использования в других модулях
window.FlxParser = FlxParser;
window.FabParser = FabParser;
window.BackupLoader = BackupLoader;
