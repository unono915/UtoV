"""UtoV 아이콘 생성 — 필름 위에 그어 놓은 두 개의 구간 표시."""
from PIL import Image, ImageDraw

INK   = (46, 40, 35, 255)     # 따뜻한 먹색 바탕
PAPER = (248, 246, 242, 255)  # 필름 띠
MARK  = (232, 135, 58, 255)   # 구간 표시 (그리스펜슬 앰버)

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 바탕
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=224, fill=INK)

# 필름 띠
d.rounded_rectangle([128, 400, 896, 624], radius=48, fill=PAPER)

# 구간을 가르는 두 표시
for cx in (352, 672):
    d.rounded_rectangle([cx - 42, 232, cx + 42, 792], radius=42, fill=MARK)

sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
frames[-1].save("assets/icon.ico", format="ICO",
                sizes=[(s, s) for s in sizes], append_images=frames[:-1])
img.resize((512, 512), Image.LANCZOS).save("assets/icon.png")
print("assets/icon.ico, assets/icon.png 생성 완료")
