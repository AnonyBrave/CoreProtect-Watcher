// Sonde lecture : mondes du cache et réglages existants (pour le mapping SquareMap).
import { db } from "../src/db.js";

const worlds = db.prepare("SELECT wid, name FROM world ORDER BY wid").all();
const settings = db.prepare("SELECT key, substr(value,1,200) v FROM setting ORDER BY key").all();
console.log(JSON.stringify({ worlds, settings }, null, 2));
