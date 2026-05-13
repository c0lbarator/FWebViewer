/**
 * FlexcilRenderer - Рендерер страниц Flexcil
 * 
 * Отвечает за отрисовку:
 * - PDF фона
 * - Рукописных рисунков (strokes)
 * - Вставленных изображений
 */

class FlexcilRenderer {
    constructor(options = {}) {
        this.pdfCanvas = options.pdfCanvas || document.getElementById('pdf-canvas');
        this.drawingsCanvas = options.drawingsCanvas || document.getElementById('drawings-canvas');
        this.imagesCanvas = options.imagesCanvas || document.getElementById('images-canvas');
        
        this.pdfCtx = this.pdfCanvas.getContext('2d');
        this.drawingsCtx = this.drawingsCanvas.getContext('2d');
        this.imagesCtx = this.imagesCanvas.getContext('2d');
        
        this.scale = 1.5; // Масштаб рендеринга
        this.zoom = 1.0; // Пользовательский зум
        
        // Базовые размеры страницы (для нормализованных координат)
        this.baseWidth = 768;
        this.baseHeight = 1024;
        
        // Реальные размеры страницы (могут быть больше если контент выходит за пределы)
        this.pageWidth = 768;
        this.pageHeight = 1024;
        
        this.pdfDoc = null;
        this.currentPage = null;
        
        this.showPdf = true;
        this.showDrawings = true;
        this.showImages = true;
        
        // Кэш изображений
        this.imageCache = new Map();
        
        // Для синхронизации с аудио
        this.visibleObjects = new Set();
        this.allObjectsVisible = true;
    }

    /**
     * Установка размеров канвасов
     */
    setCanvasSize(width, height) {
        console.log('setCanvasSize called:', width, 'x', height, 'zoom:', this.zoom, 'scale:', this.scale);
        
        this.pageWidth = width;
        this.pageHeight = height;
        
        const scaledWidth = width * this.scale * this.zoom;
        const scaledHeight = height * this.scale * this.zoom;
        
        // CSS размеры (для отображения)
        const cssWidth = scaledWidth / this.scale;
        const cssHeight = scaledHeight / this.scale;
        
        console.log('Scaled size:', scaledWidth, 'x', scaledHeight, 'CSS:', cssWidth, 'x', cssHeight);
        
        [this.pdfCanvas, this.drawingsCanvas, this.imagesCanvas].forEach(canvas => {
            canvas.width = scaledWidth;
            canvas.height = scaledHeight;
            canvas.style.width = `${cssWidth}px`;
            canvas.style.height = `${cssHeight}px`;
        });
        
        // Устанавливаем размер wrapper'а
        const wrapper = document.getElementById('page-wrapper');
        if (wrapper) {
            wrapper.style.width = `${cssWidth}px`;
            wrapper.style.height = `${cssHeight}px`;
        }
    }

    /**
     * Загрузка PDF документа
     * @param {ArrayBuffer} pdfData - Данные PDF
     */
    async loadPdf(pdfData) {
        if (!pdfData) {
            this.pdfDoc = null;
            return;
        }
        
        try {
            this.pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
        } catch (e) {
            console.error('Failed to load PDF:', e);
            this.pdfDoc = null;
        }
    }

    /**
     * Рендеринг страницы PDF
     * @param {number} pageIndex - Индекс страницы (0-based)
     */
    async renderPdfPage(pageIndex) {
        if (!this.pdfDoc || !this.showPdf) {
            return;
        }

        try {
            const page = await this.pdfDoc.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale: this.scale * this.zoom });
            
            // НЕ меняем размер канваса - он уже установлен в renderPage
            // PDF рендерится в своей области (верхняя часть страницы)
            
            await page.render({
                canvasContext: this.pdfCtx,
                viewport: viewport
            }).promise;
            
            this.currentPage = pageIndex;
        } catch (e) {
            console.error('Failed to render PDF page:', e);
        }
    }

    /**
     * Рендеринг фигур (shapes)
     * @param {Array} shapes - Массив фигур с декодированными точками
     */
    renderShapes(shapes) {
        if (!this.showDrawings || !shapes || !shapes.length) {
            return;
        }

        const ctx = this.drawingsCtx;
        const scale = this.scale * this.zoom;

        for (const shape of shapes) {
            const points = shape.points;
            if (!points || points.length < 2) continue;

            ctx.save();
            
            // Настройка стиля
            ctx.strokeStyle = shape.strokeColor;
            ctx.lineWidth = shape.lineWidth * scale;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            // Обработка типа линии (dashtype)
            if (shape.dashType === 1) {
                ctx.setLineDash([5 * scale, 5 * scale]);
            } else if (shape.dashType === 2) {
                ctx.setLineDash([2 * scale, 2 * scale]);
            }
            
            // Применение поворота если нужен
            if (shape.rotate && shape.rotate !== 0) {
                // Вычисляем центр для поворота
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const pt of points) {
                    minX = Math.min(minX, pt.x);
                    minY = Math.min(minY, pt.y);
                    maxX = Math.max(maxX, pt.x);
                    maxY = Math.max(maxY, pt.y);
                }
                const centerX = (minX + maxX) / 2 * this.baseWidth * scale;
                const centerY = (minY + maxY) / 2 * this.baseHeight * scale;
                
                ctx.translate(centerX, centerY);
                ctx.rotate(shape.rotate);
                ctx.translate(-centerX, -centerY);
            }
            
            // Заливка для замкнутых фигур
            if (shape.fillColor && shape.isClosed) {
                ctx.fillStyle = shape.fillColor;
            }

            // Отрисовка пути
            ctx.beginPath();
            
            const firstPoint = points[0];
            const firstX = firstPoint.x * this.baseWidth * scale;
            const firstY = firstPoint.y * this.baseHeight * scale;
            ctx.moveTo(firstX, firstY);

            for (let i = 1; i < points.length; i++) {
                const pt = points[i];
                const px = pt.x * this.baseWidth * scale;
                const py = pt.y * this.baseHeight * scale;
                ctx.lineTo(px, py);
            }

            // Закрытие пути если фигура замкнута
            if (shape.isClosed) {
                ctx.closePath();
            }

            // Заливка или обводка
            if (shape.fillColor && shape.isClosed) {
                ctx.fill();
            }
            ctx.stroke();
            
            ctx.restore();
        }
    }

    /**
     * Рендеринг рисунков
     * @param {Array} drawings - Массив рисунков с декодированными точками
     */
    renderDrawings(drawings) {
        this.drawingsCtx.clearRect(0, 0, this.drawingsCanvas.width, this.drawingsCanvas.height);
        
        if (!this.showDrawings || !drawings || !drawings.length) {
            return;
        }

        const ctx = this.drawingsCtx;
        const scale = this.scale * this.zoom;

        for (const drawing of drawings) {
            // Проверяем видимость объекта (для синхронизации с аудио)
            // key может быть в поле 'key' или 'objectKey' в зависимости от источника
            const drawingKey = drawing.key || drawing.objectKey;
            if (!this.allObjectsVisible && !this.visibleObjects.has(drawingKey)) {
                continue;
            }

            const points = drawing.decodedPoints;
            if (!points || points.length < 2) continue;

            // start - левый верхний угол bounding box в нормализованных координатах
            const startX = (drawing.start?.x || 0);
            const startY = (drawing.start?.y || 0);
            
            // Масштаб рисунка (обычно 1.0)
            const drawScaleX = drawing.scale?.x || 1;
            const drawScaleY = drawing.scale?.y || 1;

            ctx.save();
            
            // Настройка стиля
            ctx.strokeStyle = drawing.color?.css || 'rgba(0,0,0,1)';
            ctx.lineWidth = this.getLineWidth(drawing.mode) * scale;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            // Обработка типа линии (dashtype)
            if (drawing.dashtype === 1) {
                ctx.setLineDash([5 * scale, 5 * scale]);
            } else if (drawing.dashtype === 2) {
                ctx.setLineDash([2 * scale, 2 * scale]);
            }
            
            // Заливка для замкнутых фигур
            if (drawing.fillColor && drawing.figure !== 0) {
                ctx.fillStyle = drawing.fillColor.css;
            }

            // Отрисовка пути
            // Точки - это АБСОЛЮТНЫЕ смещения от start (не дельты!)
            // Координаты нормализованы относительно baseWidth/baseHeight
            ctx.beginPath();
            
            const firstPoint = points[0];
            // Абсолютная позиция = (start + offset) * baseSize * drawScale * renderScale
            const firstX = (startX + firstPoint.x) * this.baseWidth * drawScaleX * scale;
            const firstY = (startY + firstPoint.y) * this.baseHeight * drawScaleY * scale;
            ctx.moveTo(firstX, firstY);

            for (let i = 1; i < points.length; i++) {
                const pt = points[i];
                const px = (startX + pt.x) * this.baseWidth * drawScaleX * scale;
                const py = (startY + pt.y) * this.baseHeight * drawScaleY * scale;
                ctx.lineTo(px, py);
            }

            // Заливка или обводка
            if (drawing.fillColor && drawing.figure !== 0) {
                ctx.fill();
            }
            ctx.stroke();
            
            ctx.restore();
        }
    }

    /**
     * Получение толщины линии по режиму
     * @param {number} mode - Режим рисования
     * @returns {number}
     */
    getLineWidth(mode) {
        // mode определяет инструмент:
        // 1 - обычная ручка
        // 2 - маркер
        // 3 - карандаш
        // и т.д.
        const widths = {
            1: 2,    // Ручка
            2: 8,    // Маркер
            3: 1.5,  // Карандаш
            4: 3,    // Кисть
            5: 1     // Тонкая линия
        };
        return widths[mode] || 2;
    }

    /**
     * Рендеринг изображений
     * @param {Array} images - Массив метаданных изображений
     * @param {FlxParser} parser - Парсер для загрузки изображений
     */
    async renderImages(images, parser) {
        this.imagesCtx.clearRect(0, 0, this.imagesCanvas.width, this.imagesCanvas.height);
        
        if (!this.showImages || !images || !images.length) {
            return;
        }

        const ctx = this.imagesCtx;
        const scale = this.scale * this.zoom;

        for (const imgData of images) {
            // Проверяем видимость
            if (!this.allObjectsVisible && !this.visibleObjects.has(imgData.key)) {
                continue;
            }

            try {
                // Загружаем изображение из кэша или файла
                let img = this.imageCache.get(imgData.key);
                
                if (!img) {
                    const blob = await parser.getImage(imgData.key);
                    if (!blob) continue;
                    
                    img = await this.loadImage(URL.createObjectURL(blob));
                    this.imageCache.set(imgData.key, img);
                }

                // Вычисляем позицию и размер
                const frame = imgData.frame;
                const cropBox = imgData.cropBox || { x: 0, y: 0, width: 1, height: 1 };
                const rotate = imgData.rotate || 0;

                // Позиция на странице (нормализованные координаты относительно baseSize)
                const x = frame.x * this.baseWidth * scale;
                const y = frame.y * this.baseHeight * scale;
                const width = frame.width * this.baseWidth * scale;
                const height = frame.height * this.baseHeight * scale;

                // Область обрезки исходного изображения
                const srcX = cropBox.x * img.width;
                const srcY = cropBox.y * img.height;
                const srcWidth = cropBox.width * img.width;
                const srcHeight = cropBox.height * img.height;

                ctx.save();
                
                // Применяем поворот
                if (rotate !== 0) {
                    ctx.translate(x + width / 2, y + height / 2);
                    ctx.rotate(rotate);
                    ctx.translate(-width / 2, -height / 2);
                    ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, 0, 0, width, height);
                } else {
                    ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, x, y, width, height);
                }
                
                ctx.restore();
            } catch (e) {
                console.error('Failed to render image:', e);
            }
        }
    }

    /**
     * Загрузка изображения
     * @param {string} src - URL изображения
     * @returns {Promise<HTMLImageElement>}
     */
    loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    /**
     * Полный рендеринг страницы
     * @param {Object} pageInfo - Информация о странице из pages.index
     * @param {Object} pageData - Данные страницы (drawings, images, shapes)
     * @param {FlxParser} parser - Парсер
     */
    async renderPage(pageInfo, pageData, parser) {
        console.log('Renderer.renderPage called', { pageInfo, pageData });
        
        // Устанавливаем базовые размеры из frame
        this.baseWidth = 768;
        this.baseHeight = 1024;
        if (pageInfo.frame) {
            this.baseWidth = pageInfo.frame.width;
            this.baseHeight = pageInfo.frame.height;
        }
        
        // Вычисляем максимальные координаты из рисунков, изображений и фигур
        let maxY = 1.0;
        let maxX = 1.0;
        
        // Проверяем рисунки
        if (pageData.drawings) {
            for (const drawing of pageData.drawings) {
                const startX = drawing.start?.x || 0;
                const startY = drawing.start?.y || 0;
                const points = drawing.decodedPoints || [];
                
                for (const pt of points) {
                    maxX = Math.max(maxX, startX + pt.x);
                    maxY = Math.max(maxY, startY + pt.y);
                }
            }
        }
        
        // Проверяем изображения
        if (pageData.images && pageData.images.length > 0) {
            console.log('Checking images for bounds:', pageData.images);
            for (const img of pageData.images) {
                if (img.frame) {
                    const imgMaxX = img.frame.x + img.frame.width;
                    const imgMaxY = img.frame.y + img.frame.height;
                    console.log('Image frame:', img.frame, '-> maxX:', imgMaxX, 'maxY:', imgMaxY);
                    maxX = Math.max(maxX, imgMaxX);
                    maxY = Math.max(maxY, imgMaxY);
                }
            }
        }
        
        // Проверяем фигуры (shapes)
        if (pageData.shapes && pageData.shapes.length > 0) {
            console.log('Checking shapes for bounds:', pageData.shapes);
            for (const shape of pageData.shapes) {
                const points = shape.points || [];
                for (const pt of points) {
                    maxX = Math.max(maxX, pt.x);
                    maxY = Math.max(maxY, pt.y);
                }
            }
        }
        
        // Добавляем небольшой отступ
        maxY = Math.max(maxY, 1.0) + 0.02;
        maxX = Math.max(maxX, 1.0);
        
        // Расширяем страницу если контент выходит за пределы
        // Нормализованные координаты умножаются на baseWidth/baseHeight
        this.pageWidth = Math.max(this.baseWidth, this.baseWidth * maxX);
        this.pageHeight = Math.max(this.baseHeight, this.baseHeight * maxY);
        
        console.log('Page size:', this.pageWidth, 'x', this.pageHeight, '(maxX:', maxX, ', maxY:', maxY, ')');
        this.setCanvasSize(this.pageWidth, this.pageHeight);

        // Сначала заливаем всю страницу белым
        this.pdfCtx.fillStyle = 'white';
        this.pdfCtx.fillRect(0, 0, this.pdfCanvas.width, this.pdfCanvas.height);

        // Рендерим PDF фон (поверх белого, только в своей области)
        if (pageInfo.attachmentPage) {
            console.log('Loading PDF:', pageInfo.attachmentPage.file);
            const pdfData = await parser.getPdf(pageInfo.attachmentPage.file);
            console.log('PDF data:', pdfData ? `${pdfData.byteLength} bytes` : 'null');
            
            if (pdfData) {
                await this.loadPdf(pdfData);
                await this.renderPdfPage(pageInfo.attachmentPage.index);
                console.log('PDF rendered');
            }
        }

        // Рендерим изображения (под рисунками)
        console.log('Rendering images:', pageData.images?.length || 0);
        await this.renderImages(pageData.images, parser);

        // Рендерим рисунки
        console.log('Rendering drawings:', pageData.drawings?.length || 0);
        this.renderDrawings(pageData.drawings);
        
        // Рендерим фигуры
        console.log('Rendering shapes:', pageData.shapes?.length || 0);
        this.renderShapes(pageData.shapes);
        
        console.log('Renderer.renderPage complete');
    }

    /**
     * Установка зума
     * @param {number} zoom - Значение зума (0.25 - 4.0)
     */
    setZoom(zoom) {
        this.zoom = Math.max(0.25, Math.min(4.0, zoom));
    }

    /**
     * Установка видимости слоёв
     */
    setLayerVisibility(layer, visible) {
        switch (layer) {
            case 'pdf':
                this.showPdf = visible;
                this.pdfCanvas.style.display = visible ? 'block' : 'none';
                break;
            case 'drawings':
                this.showDrawings = visible;
                this.drawingsCanvas.style.display = visible ? 'block' : 'none';
                break;
            case 'images':
                this.showImages = visible;
                this.imagesCanvas.style.display = visible ? 'block' : 'none';
                break;
        }
    }

    /**
     * Установка видимых объектов (для синхронизации с аудио)
     * @param {Set<string>} objectKeys - Множество ключей видимых объектов
     */
    setVisibleObjects(objectKeys) {
        this.visibleObjects = objectKeys;
        this.allObjectsVisible = false;
    }

    /**
     * Показать все объекты
     */
    showAllObjects() {
        this.allObjectsVisible = true;
        this.visibleObjects.clear();
    }

    /**
     * Очистка кэша
     */
    clearCache() {
        this.imageCache.clear();
    }
}

// Экспорт
window.FlexcilRenderer = FlexcilRenderer;
