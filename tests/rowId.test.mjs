// Row ids (src/utils/rowId.js): a pull builds a dozen or more rows in one
// millisecond and saves them in one insert, so no two may share an id.
import { newRowId } from "../src/utils/rowId.js";

{
  const ids = Array.from({ length: 5000 }, newRowId);
  check("row ids: 5000 made in one go are all different", new Set(ids).size, 5000);
  check("row ids: each is higher than the one before", ids.every((id, i) => i === 0 || id > ids[i - 1]), true);
  check("row ids: whole numbers the database's bigint takes", ids.every(Number.isSafeInteger), true);
}
