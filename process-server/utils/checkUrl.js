const checkUrl = (url) => {
  try {
    if (!url || typeof url !== "string") return "";

    if (url.includes("tapi.bale.ai")) {
      const parts = url.split("/");
      return parts.at(-1) || "";
    }

    return url;
  } catch (e) {
    return "";
  }
};

module.exports = { checkUrl };