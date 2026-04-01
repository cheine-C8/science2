const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

    await page.goto('http://localhost:8000', { waitUntil: 'load' });

    await page.mouse.move(200, 200);
    await page.mouse.down();
    
    for(let i=0; i<10; i++) {
        await page.mouse.move(200 + i*10, 200 + i*10, { steps: 2 });
    }
    
    await page.mouse.up();
    
    await new Promise(r => setTimeout(r, 1000));
    await browser.close();
})();
