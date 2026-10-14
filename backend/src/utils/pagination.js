const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const getPagination = (query) => {
  const parsedPage = Number.parseInt(query.page || String(DEFAULT_PAGE), 10);
  const parsedLimit = Number.parseInt(query.limit || String(DEFAULT_LIMIT), 10);
  const page = Number.isInteger(parsedPage) && parsedPage >= 1 ? parsedPage : DEFAULT_PAGE;
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
};

module.exports = { DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT, getPagination };
