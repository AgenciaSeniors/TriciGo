#!/usr/bin/env python3
"""
TriciGo - Builds the shareable PDF that documents the reduced logo versions
used on social media. Reads the PNGs produced by build-social-logo-kit.py.

Run: python3 scripts/build-social-logo-pdf.py
Requires: reportlab  (pip install reportlab)
"""

import os
from datetime import date
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdfcanvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(ROOT, "brand", "social")
OUT = os.path.join(ROOT, "brand", "TriciGo-logo-versiones-reducidas.pdf")

W, H = A4
ORANGE = (255 / 255, 77 / 255, 0)
BLACK = (17 / 255, 17 / 255, 17 / 255)
GREY = (0.42, 0.42, 0.42)
HAIR = (0.88, 0.88, 0.88)
MARGIN = 20 * mm

MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def asset(name):
    return ImageReader(os.path.join(KIT, name))


class Doc:
    def __init__(self, path):
        self.c = pdfcanvas.Canvas(path, pagesize=A4)
        self.c.setTitle("TriciGo - Versiones reducidas del logo")
        self.c.setAuthor("TriciGo")
        self.c.setSubject("Guia de uso del logo reducido en redes sociales")
        self.page = 0

    # ---------- primitives ----------
    def text(self, x, y, s, size=10, font="Helvetica", color=BLACK):
        self.c.setFillColorRGB(*color)
        self.c.setFont(font, size)
        self.c.drawString(x, y, s)

    def para(self, x, y, s, size=10, leading=15, width=None, color=GREY):
        """Naive word-wrap paragraph. Returns the y after the last line."""
        width = width or (W - 2 * MARGIN)
        self.c.setFillColorRGB(*color)
        self.c.setFont("Helvetica", size)
        line, words = "", s.split()
        for w in words:
            probe = (line + " " + w).strip()
            if self.c.stringWidth(probe, "Helvetica", size) <= width:
                line = probe
            else:
                self.c.drawString(x, y, line)
                y -= leading
                line = w
        if line:
            self.c.drawString(x, y, line)
            y -= leading
        return y

    def rule(self, y, color=HAIR, width=0.6, x0=MARGIN, x1=W - MARGIN):
        self.c.setStrokeColorRGB(*color)
        self.c.setLineWidth(width)
        self.c.line(x0, y, x1, y)

    # ---------- page chrome ----------
    def header(self, title, kicker):
        self.page += 1
        self.text(MARGIN, H - 17 * mm, kicker.upper(), 7.5, "Helvetica-Bold", ORANGE)
        self.text(MARGIN, H - 26 * mm, title, 19, "Helvetica-Bold", BLACK)
        self.rule(H - 31 * mm)
        return H - 43 * mm

    def footer(self):
        self.rule(17 * mm)
        self.text(MARGIN, 12 * mm, "TriciGo - Versiones reducidas del logo", 7.5,
                  "Helvetica", GREY)
        self.c.setFillColorRGB(*GREY)
        self.c.setFont("Helvetica", 7.5)
        self.c.drawRightString(W - MARGIN, 12 * mm, str(self.page))
        self.c.showPage()

    # ---------- building blocks ----------
    def swatch(self, x, y, size, img, caption, detail, plate=None, checker=False,
               dark_checker=False):
        """Square logo preview with caption underneath.

        dark_checker paints the transparency grid in dark greys: a white mark on
        a light grid is invisible, which would defeat the point of the preview.
        """
        if checker:
            pair = ((0.20,) * 3, (0.28,) * 3) if dark_checker else ((0.85,) * 3, (0.93,) * 3)
            step = size / 10.0
            for i in range(10):
                for j in range(10):
                    self.c.setFillColorRGB(*(pair[1] if (i + j) % 2 else pair[0]))
                    self.c.rect(x + i * step, y + j * step, step, step, stroke=0, fill=1)
        elif plate:
            self.c.setFillColorRGB(*plate)
            self.c.rect(x, y, size, size, stroke=0, fill=1)
        self.c.drawImage(img, x, y, size, size, mask="auto")
        self.c.setStrokeColorRGB(*HAIR)
        self.c.setLineWidth(0.6)
        self.c.rect(x, y, size, size, stroke=1, fill=0)
        self.text(x, y - 7 * mm, caption, 9, "Helvetica-Bold", BLACK)
        self.text(x, y - 11.5 * mm, detail, 7.5, "Helvetica", GREY)

    def table(self, x, y, rows, widths, head=True, leading=7.2 * mm):
        for i, row in enumerate(rows):
            if head and i == 0:
                self.c.setFillColorRGB(*BLACK)
                self.c.rect(x, y - 2.2 * mm, sum(widths), 6.4 * mm, stroke=0, fill=1)
            cx = x
            for j, cell in enumerate(row):
                if head and i == 0:
                    self.text(cx + 2.5 * mm, y, cell, 8, "Helvetica-Bold", (1, 1, 1))
                else:
                    bold = j == 0
                    self.text(cx + 2.5 * mm, y, cell, 8.5,
                              "Helvetica-Bold" if bold else "Helvetica",
                              BLACK if bold else GREY)
                cx += widths[j]
            if not head or i > 0:
                self.rule(y - 2.6 * mm)
            y -= leading
        return y

    def bullets(self, x, y, items, color=BLACK, mark="-"):
        for it in items:
            self.c.setFillColorRGB(*color)
            self.c.setFont("Helvetica-Bold", 10)
            self.c.drawString(x, y, mark)
            y = self.para(x + 5 * mm, y, it, 9.5, 13.5, W - 2 * MARGIN - 5 * mm) - 3 * mm
        return y


def build():
    d = Doc(OUT)
    c = d.c
    today = date.today()
    fecha = f"{today.day} de {MESES[today.month - 1]} de {today.year}"

    # ============================ 1. Cover ============================
    c.setFillColorRGB(*BLACK)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    logo = 46 * mm
    c.drawImage(asset("tricigo-isotipo-bicolor-transparente-1024.png"),
                (W - logo) / 2, H - 118 * mm, logo, logo, mask="auto")
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica-Bold", 30)
    c.drawCentredString(W / 2, H - 144 * mm, "Versiones reducidas")
    c.setFillColorRGB(*ORANGE)
    c.drawCentredString(W / 2, H - 157 * mm, "del logo")
    c.setFillColorRGB(0.72, 0.72, 0.72)
    c.setFont("Helvetica", 11.5)
    c.drawCentredString(W / 2, H - 171 * mm, "Guía de uso para redes sociales")
    c.setStrokeColorRGB(*ORANGE)
    c.setLineWidth(1.6)
    c.line(W / 2 - 16 * mm, H - 182 * mm, W / 2 + 16 * mm, H - 182 * mm)
    c.setFillColorRGB(0.55, 0.55, 0.55)
    c.setFont("Helvetica", 9)
    c.drawCentredString(W / 2, 34 * mm, "TriciGo - Plataforma de movilidad urbana en Cuba")
    c.drawCentredString(W / 2, 28 * mm, "tricigo.com   ·   soporte@tricigo.com")
    c.setFillColorRGB(0.38, 0.38, 0.38)
    c.setFont("Helvetica", 8)
    c.drawCentredString(W / 2, 20 * mm, fecha)
    c.showPage()
    d.page = 1

    # ==================== 2. Qué es la versión reducida ====================
    y = d.header("Qué es la versión reducida", "Fundamentos")
    y = d.para(MARGIN, y,
               "La identidad de TriciGo tiene dos formas. El logo horizontal completo "
               "(wordmark) es la firma principal y se usa cuando hay espacio: webs, "
               "documentos, cabeceras y piezas impresas. La versión reducida (isotipo) "
               "es el pin con el rayo, y es la que se usa cuando el espacio es pequeño "
               "o cuadrado.", 10.5, 15.5)
    y -= 5 * mm
    y = d.para(MARGIN, y,
               "En redes sociales la foto de perfil siempre es un cuadrado que la "
               "plataforma recorta en círculo. El logo horizontal, encerrado en ese "
               "espacio, queda ilegible. Por eso el avatar de TriciGo usa siempre la "
               "versión reducida.", 10.5, 15.5)

    y -= 14 * mm
    box_h = 30 * mm
    c.setFillColorRGB(0.975, 0.975, 0.975)
    c.rect(MARGIN, y - box_h, (W - 2 * MARGIN - 8 * mm) / 2, box_h, stroke=0, fill=1)
    tile_w = (W - 2 * MARGIN - 8 * mm) / 2
    wm_w = 52 * mm
    c.drawImage(asset("tricigo-logo-horizontal-600.png"),
                MARGIN + (tile_w - wm_w) / 2, y - box_h / 2 - (wm_w * 143 / 600) / 2,
                wm_w, wm_w * 143 / 600, mask="auto")
    x2 = MARGIN + (W - 2 * MARGIN - 8 * mm) / 2 + 8 * mm
    c.setFillColorRGB(0.975, 0.975, 0.975)
    c.rect(x2, y - box_h, (W - 2 * MARGIN - 8 * mm) / 2, box_h, stroke=0, fill=1)
    iso = 22 * mm
    c.drawImage(asset("tricigo-isotipo-naranja-1024.png"),
                x2 + ((W - 2 * MARGIN - 8 * mm) / 2 - iso) / 2,
                y - box_h / 2 - iso / 2, iso, iso, mask="auto")
    d.text(MARGIN, y - box_h - 6 * mm, "Logo completo (wordmark)", 9, "Helvetica-Bold")
    d.text(MARGIN, y - box_h - 10.5 * mm, "Webs, documentos, cabeceras, impresos.", 8, "Helvetica", GREY)
    d.text(x2, y - box_h - 6 * mm, "Versión reducida (isotipo)", 9, "Helvetica-Bold")
    d.text(x2, y - box_h - 10.5 * mm, "Avatares, favicons, apps, sellos.", 8, "Helvetica", GREY)

    y = y - box_h - 24 * mm
    d.text(MARGIN, y, "Cuándo usar cada una", 12, "Helvetica-Bold")
    y -= 9 * mm
    y = d.table(MARGIN, y, [
        ["Pieza", "Versión a usar"],
        ["Foto de perfil / avatar", "Reducida (isotipo), fondo naranja"],
        ["Portada o cabecera", "Logo completo sobre fondo liso de la paleta"],
        ["Marca de agua sobre foto", "Reducida en blanco, versión transparente"],
        ["Sello en videos y reels", "Reducida bicolor, versión transparente"],
        ["Firma en documentos", "Logo completo"],
    ], [72 * mm, 98 * mm])
    d.footer()

    # ============================ 3. Variantes ============================
    y = d.header("Variantes disponibles", "El kit")
    y = d.para(MARGIN, y,
               "Tres versiones sobre fondo sólido, listas para subir como foto de "
               "perfil, y tres versiones con fondo transparente para superponer sobre "
               "fotos, portadas y video.", 10.5, 15.5)

    y -= 12 * mm
    sw = 46 * mm
    gap = (W - 2 * MARGIN - 3 * sw) / 2
    row1 = y - sw
    d.swatch(MARGIN, row1, sw, asset("tricigo-isotipo-naranja-1024.png"),
             "Naranja - principal", "Fondo #FF4D00. Es el avatar por defecto.")
    d.swatch(MARGIN + sw + gap, row1, sw, asset("tricigo-isotipo-negro-1024.png"),
             "Negra", "Fondo #111111. Para piezas de fondo claro.")
    d.swatch(MARGIN + 2 * (sw + gap), row1, sw, asset("tricigo-isotipo-blanco-1024.png"),
             "Blanca", "Fondo #FFFFFF. Prensa y documentos.")

    row2 = row1 - sw - 26 * mm
    d.swatch(MARGIN, row2, sw, asset("tricigo-isotipo-blanco-transparente-1024.png"),
             "Blanca transparente", "Sobre fotos oscuras.", checker=True, dark_checker=True)
    d.swatch(MARGIN + sw + gap, row2, sw, asset("tricigo-isotipo-naranja-transparente-1024.png"),
             "Naranja transparente", "Sobre fondos claros.", checker=True)
    d.swatch(MARGIN + 2 * (sw + gap), row2, sw, asset("tricigo-isotipo-bicolor-transparente-1024.png"),
             "Bicolor transparente", "Sobre fondos oscuros lisos.", checker=True, dark_checker=True)

    y = row2 - 22 * mm
    d.text(MARGIN, y, "Regla rápida", 12, "Helvetica-Bold")
    y -= 8 * mm
    d.bullets(MARGIN, y, [
        "Si la pieza es de TriciGo y manda la marca, el fondo va naranja.",
        "Si la pieza ya tiene mucho color o una foto, el isotipo va en blanco sobre la versión transparente.",
        "El fondo negro se reserva para piezas sobrias o material del área de conductores.",
    ])
    d.footer()

    # ======================= 4. Uso en redes sociales =======================
    y = d.header("Uso en redes sociales", "Medidas")
    y = d.para(MARGIN, y,
               "Subí siempre el archivo de 1024 x 1024 px. Cada red lo reescala a su "
               "medida y así el avatar se ve nítido también en pantallas de alta "
               "densidad. Los tamaños de la tabla son de referencia: indican a qué "
               "medida muestra el avatar cada plataforma, no el archivo a subir.",
               10.5, 15.5)
    y -= 8 * mm
    y = d.table(MARGIN, y, [
        ["Plataforma", "Muestra el avatar a", "Recorte", "Archivo recomendado"],
        ["Instagram", "320 x 320 px", "Círculo", "1024 x 1024"],
        ["Facebook", "170 x 170 px", "Círculo", "1024 x 1024"],
        ["X (Twitter)", "400 x 400 px", "Círculo", "1024 x 1024"],
        ["LinkedIn", "300 x 300 px", "Círculo", "1024 x 1024"],
        ["YouTube", "800 x 800 px", "Círculo", "1024 x 1024"],
        ["TikTok", "200 x 200 px", "Círculo", "1024 x 1024"],
        ["WhatsApp Business", "640 x 640 px", "Círculo", "1024 x 1024"],
        ["Telegram", "512 x 512 px", "Círculo", "1024 x 1024"],
    ], [46 * mm, 44 * mm, 34 * mm, 46 * mm])

    y -= 10 * mm
    d.text(MARGIN, y, "Recorte circular y zona de seguridad", 12, "Helvetica-Bold")
    y -= 8 * mm
    ry = y - 44 * mm
    prev = 44 * mm
    c.drawImage(asset("tricigo-isotipo-naranja-1024.png"), MARGIN, ry, prev, prev, mask="auto")
    c.setStrokeColorRGB(1, 1, 1)
    c.setLineWidth(0.9)
    c.setDash(3, 3)
    c.circle(MARGIN + prev / 2, ry + prev / 2, prev / 2, stroke=1, fill=0)
    c.circle(MARGIN + prev / 2, ry + prev / 2, prev * 0.36, stroke=1, fill=0)
    c.setDash()
    tx = MARGIN + prev + 10 * mm
    d.para(tx, y - 4 * mm,
           "El isotipo está centrado dentro del cuadrado y su punto más alejado "
           "queda al 72 % del radio. Sobrevive entero al recorte circular de "
           "cualquier red, con margen de sobra.", 9.5, 13.5, W - MARGIN - tx)
    d.para(tx, y - 26 * mm,
           "No amplíes ni recortes el archivo para que el pin se vea más grande: "
           "el aire alrededor es parte del logo.", 9.5, 13.5, W - MARGIN - tx)
    d.para(tx, y - 48 * mm,
           "Tamaño mínimo: 24 px de lado. Por debajo, el rayo deja de leerse.",
           9.5, 13.5, W - MARGIN - tx, color=BLACK)

    # Real-size strip, anchored to the bottom margin so it can never collide
    # with the footer rule no matter how the block above reflows.
    px_to_pt = 72.0 / 96.0
    base = 32 * mm
    top_line = base + 170 * px_to_pt
    d.text(MARGIN, top_line + 15 * mm, "Cómo se ve a tamaño real", 12, "Helvetica-Bold")
    d.para(MARGIN, top_line + 9 * mm,
           "Muestras al tamaño aproximado con que cada pantalla las presenta "
           "(96 ppp). El isotipo sigue siendo reconocible hasta el mínimo.", 9.5, 13.5)
    x = MARGIN
    for px_size, label, ctx in ((170, "170 px", "Facebook"), (80, "80 px", "Lista de chats"),
                                (40, "40 px", "Comentario"), (24, "24 px", "Mínimo")):
        side = px_size * px_to_pt
        # top-aligned: the eye reads the size drop as a descending staircase
        c.drawImage(asset("tricigo-isotipo-naranja-1024.png"), x, top_line - side,
                    side, side, mask="auto")
        d.text(x, base - 6 * mm, label, 8, "Helvetica-Bold", BLACK)
        d.text(x, base - 10 * mm, ctx, 7.5, "Helvetica", GREY)
        col = max(side, c.stringWidth(ctx, "Helvetica", 7.5))
        x += col + 11 * mm
    d.footer()

    # ==================== 5. Paleta y usos incorrectos ====================
    y = d.header("Paleta y usos incorrectos", "Reglas")
    d.text(MARGIN, y, "Colores de marca", 12, "Helvetica-Bold")
    y -= 12 * mm
    sw2 = 30 * mm
    for i, (name, hexv, rgb, use) in enumerate([
        ("Go Orange", "#FF4D00", ORANGE, "Color principal"),
        ("Trici Black", "#111111", BLACK, "Texto y fondos"),
        ("Blanco", "#FFFFFF", (1, 1, 1), "Fondos y figura"),
    ]):
        x = MARGIN + i * (sw2 + 12 * mm)
        c.setFillColorRGB(*rgb)
        c.rect(x, y - sw2, sw2, sw2, stroke=0, fill=1)
        c.setStrokeColorRGB(*HAIR)
        c.setLineWidth(0.6)
        c.rect(x, y - sw2, sw2, sw2, stroke=1, fill=0)
        d.text(x, y - sw2 - 6 * mm, name, 9, "Helvetica-Bold")
        d.text(x, y - sw2 - 10.5 * mm, hexv, 8, "Helvetica", GREY)
        d.text(x, y - sw2 - 14.5 * mm, use, 7.5, "Helvetica", GREY)

    y = y - sw2 - 26 * mm
    d.para(MARGIN, y,
           "El logo solo se coloca sobre blanco, sobre #111111 o sobre #FF4D00. "
           "Sobre una foto, usá la versión transparente en blanco y asegurá "
           "contraste suficiente.", 10, 14.5)

    y -= 14 * mm
    d.text(MARGIN, y, "Qué no hacer", 12, "Helvetica-Bold")
    y -= 9 * mm
    y = d.bullets(MARGIN, y, [
        "No deformar, rotar ni inclinar el logo. Escalalo siempre en proporción.",
        "No cambiar los colores ni aplicar degradados, sombras o contornos.",
        "No usar el logo horizontal completo como foto de perfil: a esa medida no se lee.",
        "No recortar el pin ni acercarlo hasta los bordes del cuadrado.",
        "No reconstruir el logo a mano ni reemplazar la tipografía del wordmark.",
        "No colocarlo sobre fondos de colores ajenos a la paleta ni sobre fotos con poco contraste.",
    ])

    y -= 8 * mm
    ex = 34 * mm
    gap2 = (W - 2 * MARGIN - 3 * ex) / 2
    top = y - ex
    iso_src = asset("tricigo-isotipo-naranja-1024.png")
    white_src = asset("tricigo-isotipo-blanco-transparente-1024.png")

    # a) stretched out of proportion
    c.saveState()
    c.setFillColorRGB(*ORANGE)
    c.rect(MARGIN, top, ex, ex, stroke=0, fill=1)
    c.drawImage(white_src, MARGIN - ex * 0.16, top + ex * 0.10,
                ex * 1.32, ex * 0.80, mask="auto")
    c.restoreState()

    # b) rotated - only the mark turns; the plate stays square so the sample
    #    cannot spill over its column or collide with the caption below
    x_b = MARGIN + ex + gap2
    c.setFillColorRGB(*ORANGE)
    c.rect(x_b, top, ex, ex, stroke=0, fill=1)
    c.saveState()
    c.translate(x_b + ex / 2, top + ex / 2)
    c.rotate(17)
    c.drawImage(white_src, -ex / 2, -ex / 2, ex, ex, mask="auto")
    c.restoreState()

    # c) off-palette plate
    x_c = MARGIN + 2 * (ex + gap2)
    c.setFillColorRGB(0.13, 0.36, 0.78)
    c.rect(x_c, top, ex, ex, stroke=0, fill=1)
    c.drawImage(white_src, x_c, top, ex, ex, mask="auto")

    for i, (xx, cap) in enumerate(((MARGIN, "Deformado"), (x_b, "Rotado"),
                                   (x_c, "Color fuera de paleta"))):
        # "prohibited" badge
        c.setFillColorRGB(1, 1, 1)
        c.setStrokeColorRGB(0.80, 0.09, 0.09)
        c.setLineWidth(1.4)
        cxx, cyy, r = xx + ex - 5 * mm, top + ex - 5 * mm, 3.6 * mm
        c.circle(cxx, cyy, r, stroke=1, fill=1)
        c.line(cxx - r * 0.62, cyy + r * 0.62, cxx + r * 0.62, cyy - r * 0.62)
        d.text(xx, top - 6 * mm, cap, 8.5, "Helvetica-Bold", (0.80, 0.09, 0.09))
    d.footer()

    # ======================== 6. Archivos incluidos ========================
    y = d.header("Archivos incluidos", "Entrega")
    y = d.para(MARGIN, y,
               "Todos los archivos son PNG. Los de fondo sólido vienen en tres medidas; "
               "para redes sociales usá siempre el de 1024 px.", 10.5, 15.5)
    y -= 8 * mm
    y = d.table(MARGIN, y, [
        ["Archivo", "Medida", "Uso"],
        ["tricigo-isotipo-naranja-1024.png", "1024 px", "Avatar principal"],
        ["tricigo-isotipo-naranja-512.png", "512 px", "Avatar, uso secundario"],
        ["tricigo-isotipo-naranja-400.png", "400 px", "Avatar, uso secundario"],
        ["tricigo-isotipo-negro-1024.png", "1024 px", "Avatar sobre piezas claras"],
        ["tricigo-isotipo-negro-512.png", "512 px", "Variante negra"],
        ["tricigo-isotipo-negro-400.png", "400 px", "Variante negra"],
        ["tricigo-isotipo-blanco-1024.png", "1024 px", "Prensa y documentos"],
        ["tricigo-isotipo-blanco-512.png", "512 px", "Variante blanca"],
        ["tricigo-isotipo-blanco-400.png", "400 px", "Variante blanca"],
        ["tricigo-isotipo-blanco-transparente-1024.png", "1024 px", "Sobre fotos oscuras"],
        ["tricigo-isotipo-naranja-transparente-1024.png", "1024 px", "Sobre fondos claros"],
        ["tricigo-isotipo-bicolor-transparente-1024.png", "1024 px", "Sobre fondos oscuros"],
        ["tricigo-logo-horizontal-600.png", "600 x 143 px", "Logo completo, fondo claro"],
        ["tricigo-logo-horizontal-blanco-600.png", "600 x 143 px", "Logo completo, fondo oscuro"],
    ], [82 * mm, 30 * mm, 58 * mm], leading=6.6 * mm)

    y -= 8 * mm
    c.setFillColorRGB(0.975, 0.975, 0.975)
    box_top = y
    c.rect(MARGIN, y - 30 * mm, W - 2 * MARGIN, 30 * mm, stroke=0, fill=1)
    c.setFillColorRGB(*ORANGE)
    c.rect(MARGIN, y - 30 * mm, 1.4 * mm, 30 * mm, stroke=0, fill=1)
    d.text(MARGIN + 7 * mm, box_top - 9 * mm, "¿Necesitás otro formato?", 10, "Helvetica-Bold")
    d.para(MARGIN + 7 * mm, box_top - 15 * mm,
           "Si hace falta el logo en vector (SVG, EPS, AI) para impresión en gran "
           "formato, o una medida que no esté en esta entrega, escribinos a "
           "soporte@tricigo.com y lo preparamos.", 9, 13, W - 2 * MARGIN - 14 * mm)
    d.footer()

    d.c.save()
    print("PDF:", OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    build()
