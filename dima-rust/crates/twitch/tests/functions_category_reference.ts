// Run with the main checkout's tsx; imports only the frozen pure module.
import { writeFileSync } from 'node:fs';
import { categoryTokens, categoryQueries, categoryMatchScore } from '/home/dom/Projects/saas/dimabot/src/functions/search/category_matching.ts';
const cases = [
 ['mortal shell 2','Mortal Shell II'], ['dark souls III','Dark Souls 3'],
 ['final fantasy 14 online','FINAL FANTASY XIV Online'], ['baldurs gate3','Baldur’s Gate III'],
 ['civilization 6',"Sid Meier's Civilization VI"], ['witcher 3','The Witcher 3: Wild Hunt'],
 ['cyberpunk 2077','Cyberpunk 2077'], ['mortal shell 2','Mortal Shell'],
 ['  Pokémon:   Violet  ','Pokémon Violet'], ['V Rising','V Rising'], ['fort','Fortnite'],
 ['fort','Fortnite Festival'], ['dark souls 2','Dark Souls II: Remastered'],
 ['',''], ['🙂 café 2','🙂 CAFE II'], ['אבג 2','אבג II'], ['e\u0301 3','É III'],
 ['I Am Alive','I Am Alive'], ['Test 02','Test II'], ['Test 2','Test 20'],
];
writeFileSync(process.argv[2], JSON.stringify(cases.map(([query,title]) => ({query,title,tokens:categoryTokens(query),queries:categoryQueries(query),score:categoryMatchScore(query,title)})),null,2)+'\n');
