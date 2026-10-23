// Inspect actual screenshot pixels using Chromium's PNG decoder, without image dependencies.
export async function pixelStats(page, selector) {
  const target = typeof selector === "string" ? page.locator(selector) : selector;
  const png = await target.screenshot();
  return page.evaluate(
    async (dataURL) => {
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const counts = { cyan: 0, violet: 0, gold: 0, blue: 0 };
      const bins = Array.from({ length: 20 }, () =>
        Array.from({ length: 64 }, () => ({
          cyan: 0,
          violet: 0,
          gold: 0,
          blue: 0,
        })),
      );
      const near = (r, g, b, c) =>
        Math.abs(r - c[0]) < 14 &&
        Math.abs(g - c[1]) < 14 &&
        Math.abs(b - c[2]) < 14;
      for (let pixel = 0; pixel < image.width * image.height; pixel++) {
        const [r, g, b] = data.subarray(pixel * 4, pixel * 4 + 3);
        const kind = near(r, g, b, [118, 213, 255])
          ? "cyan"
          : near(r, g, b, [181, 161, 255]) || near(r, g, b, [147, 51, 234])
            ? "violet"
            : r > 210 && g > 130 && g < 230 && b < 110
              ? "gold"
              : near(r, g, b, [37, 99, 235]) || (r < 80 && g > 40 && b > 90 && b < 225)
                ? "blue"
                : null;
        if (!kind) continue;
        counts[kind]++;
        bins[
          Math.min(
            19,
            Math.floor((Math.floor(pixel / image.width) / image.height) * 20),
          )
        ][Math.min(63, Math.floor(((pixel % image.width) / image.width) * 64))][
          kind
        ]++;
      }
      const symbols = { cyan: "C", violet: "V", gold: "G", blue: "B" };
      const thumbnail = bins
        .map((row) =>
          row
            .map((bin) => {
              const [kind, count] = Object.entries(bin).sort(
                (a, b) => b[1] - a[1],
              )[0];
              return count > 1 ? symbols[kind] : ".";
            })
            .join(""),
        )
        .join("\n");
      return { width: image.width, height: image.height, ...counts, thumbnail };
    },
    "data:image/png;base64," + png.toString("base64"),
  );
}
