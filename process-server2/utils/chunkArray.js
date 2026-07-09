function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(
      array.slice(i, i + size).map((age) => ({ text: String(age) })),
    );
  }
  return result;
}


module.exports = chunkArray;
