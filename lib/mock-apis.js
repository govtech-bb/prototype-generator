/**
 * Mock government API services for prototype testing.
 *
 * 1. Trident ID — returns citizen details by National Registration Number
 * 2. Licensing Authority — returns vehicle details by licence plate number
 *
 * All data is fictional and used only for prototype demonstrations.
 */

'use strict';

/* ═══════════════════════════════════════════════
   Trident ID — citizen identity lookup
   ═══════════════════════════════════════════════ */

const CITIZENS = {
  '870315-1234': {
    firstName: 'Keisha',
    middleName: 'Marie',
    lastName: 'Brathwaite',
    dateOfBirth: { day: '15', month: '03', year: '1987' },
    gender: 'Female',
    email: 'keisha.brathwaite@email.com',
    mobile: '246-555-0147',
    landline: '246-434-0012',
    streetAddress: '42 Hastings Main Road',
    parish: 'Christ Church',
    postalCode: 'BB15028',
    nationalInsurance: '198703',
  },
  '910822-5678': {
    firstName: 'Dwayne',
    middleName: '',
    lastName: 'Alleyne',
    dateOfBirth: { day: '22', month: '08', year: '1991' },
    gender: 'Male',
    email: 'dwayne.alleyne@email.com',
    mobile: '246-555-0293',
    landline: '',
    streetAddress: '17 Pine Hill, St. Michael',
    parish: 'St. Michael',
    postalCode: 'BB11113',
    nationalInsurance: '199108',
  },
  '760510-9012': {
    firstName: 'Sandra',
    middleName: 'Ann',
    lastName: 'Cumberbatch',
    dateOfBirth: { day: '10', month: '05', year: '1976' },
    gender: 'Female',
    email: 'sandra.cumberbatch@email.com',
    mobile: '246-555-0381',
    landline: '246-228-5544',
    streetAddress: '8 Sunset Crest, Holetown',
    parish: 'St. James',
    postalCode: 'BB24017',
    nationalInsurance: '197605',
  },
  '000101-0001': {
    firstName: 'Abisola',
    middleName: '',
    lastName: 'Fatokun',
    dateOfBirth: { day: '01', month: '01', year: '2000' },
    gender: 'Male',
    email: 'abisola.fatokun@govtech.bb',
    mobile: '246-555-0100',
    landline: '',
    streetAddress: '1 Warrens Tower, Warrens',
    parish: 'St. Michael',
    postalCode: 'BB22026',
    nationalInsurance: '200001',
  },
};

function lookupCitizen(nationalId) {
  if (!nationalId || typeof nationalId !== 'string') {
    return { success: false, error: 'National Registration Number is required.' };
  }

  const cleaned = nationalId.trim();

  if (!/^\d{6}-\d{4}$/.test(cleaned)) {
    return {
      success: false,
      error: 'Invalid format. National Registration Number should be YYMMDD-XXXX (for example, 870315-1234).',
    };
  }

  const citizen = CITIZENS[cleaned];
  if (!citizen) {
    return {
      success: false,
      error: 'No record found for this National Registration Number. Please check and try again.',
    };
  }

  return { success: true, data: { ...citizen } };
}

/* ═══════════════════════════════════════════════
   Licensing Authority — vehicle lookup
   ═══════════════════════════════════════════════ */

const VEHICLES = {
  'B 1234': {
    plate: 'B 1234',
    make: 'Toyota',
    model: 'Corolla',
    year: '2019',
    colour: 'Silver',
    engineNumber: 'EN-2ZR-7849201',
    chassisNumber: 'JTDBT923-X91234567',
    ownerId: '870315-1234',
    ownerName: 'Keisha Marie Brathwaite',
  },
  'B 5678': {
    plate: 'B 5678',
    make: 'Hyundai',
    model: 'Tucson',
    year: '2021',
    colour: 'Blue',
    engineNumber: 'EN-G4FJ-3921047',
    chassisNumber: 'KMHJ3814-MU567890',
    ownerId: '910822-5678',
    ownerName: 'Dwayne Alleyne',
  },
  'B 9012': {
    plate: 'B 9012',
    make: 'Nissan',
    model: 'X-Trail',
    year: '2017',
    colour: 'White',
    engineNumber: 'EN-QR25-5578302',
    chassisNumber: 'JN1TBNT3-1Z901234',
    ownerId: '760510-9012',
    ownerName: 'Sandra Ann Cumberbatch',
  },
  'B 0001': {
    plate: 'B 0001',
    make: 'Honda',
    model: 'Civic',
    year: '2022',
    colour: 'Black',
    engineNumber: 'EN-L15B-8830194',
    chassisNumber: 'SHHFK7H6-0NU000123',
    ownerId: '000101-0001',
    ownerName: 'Abisola Fatokun',
  },
};

function lookupVehicle(plate) {
  if (!plate || typeof plate !== 'string') {
    return { success: false, error: 'Licence plate number is required.' };
  }

  const cleaned = plate.trim().toUpperCase();

  const vehicle = VEHICLES[cleaned];
  if (!vehicle) {
    return {
      success: false,
      error: 'No vehicle found for this licence plate number. Please check and try again.',
    };
  }

  return { success: true, data: { ...vehicle } };
}

/* ═══════════════════════════════════════════════
   CAIPO — business / company lookup
   ═══════════════════════════════════════════════ */

const BUSINESSES = {
  'BB-2019-04521': {
    companyRegistrationNumber: 'BB-2019-04521',
    entityName: 'Bajan Solar Solutions Ltd.',
    entityStatus: 'Active',
    companyType: 'Private Company',
    dateOfIncorporation: { day: '14', month: '03', year: '2019' },
    registeredOfficeAddress: '25 Warrens Industrial Park, Warrens',
    parish: 'St. Michael',
    postalCode: 'BB22026',
    tin: '1-0045-2100-019',
    nisNumber: 'NIS-890421',
    businessNameRegistration: '',
    directors: 'Keisha Marie Brathwaite (Director), Marcus A. Hinds (Director)',
  },
  'BB-2015-01287': {
    companyRegistrationNumber: 'BB-2015-01287',
    entityName: 'Island Fresh Produce Inc.',
    entityStatus: 'Active',
    companyType: 'Private Company',
    dateOfIncorporation: { day: '22', month: '07', year: '2015' },
    registeredOfficeAddress: '8 Bridgetown Harbour Road',
    parish: 'St. Michael',
    postalCode: 'BB11000',
    tin: '1-0031-2870-015',
    nisNumber: 'NIS-750287',
    businessNameRegistration: '',
    directors: 'Dwayne Alleyne (Managing Director)',
  },
  'BB-2021-07893': {
    companyRegistrationNumber: 'BB-2021-07893',
    entityName: 'Cumberbatch & Associates',
    entityStatus: 'Active',
    companyType: 'Partnership',
    dateOfIncorporation: { day: '05', month: '11', year: '2021' },
    registeredOfficeAddress: '12 Broad Street, Suite 4',
    parish: 'St. Michael',
    postalCode: 'BB11114',
    tin: '1-0078-9300-021',
    nisNumber: 'NIS-210789',
    businessNameRegistration: 'BN-2021-3344',
    directors: 'Sandra Ann Cumberbatch (Senior Partner), Leon R. Cumberbatch (Partner)',
  },
  'BB-2022-00100': {
    companyRegistrationNumber: 'BB-2022-00100',
    entityName: 'GovTech Barbados Ltd.',
    entityStatus: 'Active',
    companyType: 'Non-Profit',
    dateOfIncorporation: { day: '01', month: '06', year: '2022' },
    registeredOfficeAddress: '1 Warrens Tower, Warrens',
    parish: 'St. Michael',
    postalCode: 'BB22026',
    tin: '1-0001-0000-022',
    nisNumber: 'NIS-220010',
    businessNameRegistration: '',
    directors: 'Abisola Fatokun (CEO)',
  },
  'BB-2010-05500': {
    companyRegistrationNumber: 'BB-2010-05500',
    entityName: 'Caribbean Blue Charters Ltd.',
    entityStatus: 'Dissolved',
    companyType: 'Private Company',
    dateOfIncorporation: { day: '18', month: '02', year: '2010' },
    registeredOfficeAddress: '77 Carlisle Bay Marina',
    parish: 'St. Michael',
    postalCode: 'BB11000',
    tin: '1-0055-0000-010',
    nisNumber: 'NIS-100550',
    businessNameRegistration: 'BN-2010-1122',
    directors: 'Retired record',
  },
};

function lookupBusiness(registrationNumber) {
  if (!registrationNumber || typeof registrationNumber !== 'string') {
    return { success: false, error: 'Company Registration Number is required.' };
  }

  const cleaned = registrationNumber.trim().toUpperCase();

  if (!/^BB-\d{4}-\d{4,5}$/.test(cleaned)) {
    return {
      success: false,
      error: 'Invalid format. Company Registration Number should be BB-YYYY-NNNNN (for example, BB-2019-04521).',
    };
  }

  const business = BUSINESSES[cleaned];
  if (!business) {
    return {
      success: false,
      error: 'No business found for this registration number. Please check and try again.',
    };
  }

  return { success: true, data: { ...business } };
}

module.exports = { lookupCitizen, lookupVehicle, lookupBusiness, CITIZENS, VEHICLES, BUSINESSES };
