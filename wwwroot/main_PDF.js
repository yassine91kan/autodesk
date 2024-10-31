const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib
              
async function createPdf() {
  // Create a new PDFDocument
  const pdfDoc = await PDFDocument.create()

  // Embed the Times Roman font
  const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman)

  // Add a blank page to the document
  const page = pdfDoc.addPage()

  // Get the width and height of the page
  const { width, height } = page.getSize()

  // Draw a string of text toward the top of the page
  const fontSize = 20
  page.drawText('Draft created by BV Augmented', {
    x: page.getWidth() / 6,
    y: page.getHeight() / 2,
    size: fontSize,
    font: timesRomanFont,
    color: rgb(0, 0.53, 0.71),
  })

  // Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 150;
    const cellHeight = 30;
  
    // Define table's top-left corner position
    const startX = 50;
    const startY = 300;

    for(let i=0;i<5;i++){

        // Draw table cells as rectangles
        page.drawRectangle({
        x: startX,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,
      });

      page.drawRectangle({
        x: startX + cellWidth,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,
      });

     page.drawText('75.00008', {
      x: startX + 10,
      y: startY - cellHeight*(i+1)+10 ,
      size: 10,
      color: rgb(0, 0, 0),
    });
    page.drawText('-45.00008', {
      x: startX + cellWidth + 10,
      y: startY - cellHeight*(i+1) +10,
      size: 10,
      color: rgb(0, 0, 0),
    });


    }
  
  
    // Add text to each cell
    page.drawText('Pile Longitude', {
      x: startX + 10,
      y: startY +10,
      size: 10,
      color: rgb(0, 0, 0),
    });
    page.drawText('Pile Latitude', {
      x: startX + cellWidth + 10,
      y: startY +10,
      size: 10,
      color: rgb(0, 0, 0),
    });
 

  // Serialize the PDFDocument to bytes (a Uint8Array)
  const pdfBytes = await pdfDoc.save()

  // Trigger the browser to download the PDF document
  download(pdfBytes, "pdf-lib_creation_example.pdf", "application/pdf");
}


async function modifyPdf() {
    // Fetch an existing PDF document
    const url = './title_block.pdf'
    const existingPdfBytes = await fetch(url).then(res => res.arrayBuffer())

// Load a PDFDocument from the existing PDF bytes
const pdfDoc = await PDFDocument.load(existingPdfBytes)

// Embed the Helvetica font
const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica)

// Get the first page of the document
const pages = pdfDoc.getPages()
const firstPage = pages[0]

// Get the width and height of the first page
const { width, height } = firstPage.getSize();

console.log(firstPage.getSize());

// Draw a string of text diagonally across the first page
firstPage.drawText('This text was added with JavaScript!', {
  x: 5,
  y: height / 2 + 300,
  size: 50,
  font: helveticaFont,
  color: rgb(0.95, 0.1, 0.1),
  rotate: degrees(45),
})

// Add a table of two columns and two rows 

    // Define cell width and height
    const cellWidth = 150;
    const cellHeight = 30;
  
    // Define table's top-left corner position
    const startX = width/2;
    const startY = height/2;

    for(let i=0;i<20;i++){

        // Draw table cells as rectangles
        firstPage.drawRectangle({
        x: startX,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawRectangle({
        x: startX + cellWidth,
        y: startY- cellHeight*i,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,

      });

      firstPage.drawText('75.00008', {
      x: startX + 10,
      y: startY - cellHeight*(i+1)+10 ,
      size: 10,
      color: rgb(0, 0, 0),

    });
    firstPage.drawText('-45.00008', {
      x: startX + cellWidth + 10,
      y: startY - cellHeight*(i+1) +10,
      size: 10,
      color: rgb(0, 0, 0),

    });


    }
  
  
    // Add text to each cell
    firstPage.drawText('Pile Longitude', {
      x: startX + 10,
      y: startY +10,
      size: 10,
      color: rgb(0, 0, 0),

    });
    firstPage.drawText('Pile Latitude', {
      x: startX + cellWidth + 10,
      y: startY +10,
      size: 10,
      color: rgb(0, 0, 0),

    });

// Serialize the PDFDocument to bytes (a Uint8Array)
const pdfBytes = await pdfDoc.save()

      // Trigger the browser to download the PDF document
download(pdfBytes, "pdf-lib_modification_example.pdf", "application/pdf");


}


// document.getElementById('PDF').addEventListener("click", () => 
    
//     modifyPdf());

