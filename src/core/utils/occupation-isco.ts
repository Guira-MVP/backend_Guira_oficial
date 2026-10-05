/**
 * Ocupación de Guira (código O*NET-SOC que usa Bridge en
 * most_recent_occupation) → código ISCO-08 de 4 dígitos para
 * profession.isco_code de Tazapay.
 *
 * Tazapay valida la ocupación contra ISCO-08 y rechaza títulos libres
 * (sandbox 2026-10-05, error 2642). Tabla aprobada el 2026-10-05:
 * Docuemntacion_nueva_integracion/07_ocupaciones_onet_isco/TABLA_FINAL_ONET_ISCO08.xlsx
 * Generado por scripts/gen_ts.py de esa carpeta. No editar a mano.
 *
 * Sin entrada = no se envía ocupación (p. ej. 999999 "Unemployed").
 */
export const OCCUPATION_TO_ISCO08: Readonly<Record<string, string>> = {
  '111011': '1120', // Managing directors and chief executives
  '111021': '1120', // Managing directors and chief executives
  '111031': '1111', // Legislators
  '112011': '1222', // Advertising and public relations managers
  '112021': '1221', // Sales and marketing managers
  '112022': '1221', // Sales and marketing managers
  '112030': '1222', // Advertising and public relations managers
  '113012': '1219', // Business services and administration managers not elsewhere classified
  '113013': '1219', // Business services and administration managers not elsewhere classified
  '113021': '1330', // Information and communications technology service managers
  '113031': '1211', // Finance managers
  '113051': '1321', // Manufacturing managers
  '113061': '1324', // Supply, distribution and related managers
  '113071': '1324', // Supply, distribution and related managers
  '113111': '1212', // Human resource managers
  '113121': '1212', // Human resource managers
  '113131': '1212', // Human resource managers
  '119013': '1311', // Agricultural and forestry production managers
  '119021': '1323', // Construction managers
  '119030': '1345', // Education managers
  '119041': '1223', // Research and development managers
  '119051': '1412', // Restaurant managers
  '119070': '1431', // Sports, recreation and cultural centre managers
  '119081': '1411', // Hotel managers
  '119111': '1342', // Health services managers
  '119121': '1223', // Research and development managers
  '119131': '1349', // Professional services managers not elsewhere classified
  '119141': '3334', // Real estate agents and property managers
  '119151': '1344', // Social welfare managers
  '119161': '1112', // Senior government officials
  '119171': '5163', // Undertakers and embalmers
  '119179': '1431', // Sports, recreation and cultural centre managers
  '119199': '1219', // Business services and administration managers not elsewhere classified
  '131011': '3339', // Business services agents not elsewhere classified
  '131021': '3323', // Buyers
  '131022': '3323', // Buyers
  '131023': '3323', // Buyers
  '131030': '3315', // Valuers and loss assessors
  '131041': '2619', // Legal professionals not elsewhere classified
  '131051': '3339', // Business services agents not elsewhere classified
  '131070': '2423', // Personnel and careers professionals
  '131081': '1324', // Supply, distribution and related managers
  '131082': '2421', // Management and organisation analysts
  '131111': '2421', // Management and organisation analysts
  '131121': '3332', // Conference and event planners
  '131131': '2432', // Public relations professionals
  '131141': '2423', // Personnel and careers professionals
  '131151': '2424', // Training and staff development professionals
  '131161': '2431', // Advertising and marketing professionals
  '131199': '3339', // Business services agents not elsewhere classified
  '132011': '2411', // Accountants
  '132020': '3315', // Valuers and loss assessors
  '132031': '2411', // Accountants
  '132041': '2413', // Financial analysts
  '132051': '2412', // Financial and investment advisers
  '132052': '2412', // Financial and investment advisers
  '132053': '3321', // Insurance representatives
  '132061': '2411', // Accountants
  '132070': '3312', // Credit and loans officers
  '132081': '3352', // Government tax and excise officials
  '132082': '2411', // Accountants
  '1320XX': '2411', // Accountants
  '151211': '2511', // Systems analysts
  '151212': '2529', // Database and network professionals not elsewhere classified
  '151221': '2511', // Systems analysts
  '151230': '3512', // Information and communications technology user support technicians
  '151241': '2523', // Computer network professionals
  '151244': '2522', // Systems administrators
  '15124X': '2521', // Database designers and administrators
  '151251': '2514', // Applications programmers
  '151252': '2512', // Software developers
  '151253': '2519', // Software and applications developers and analysts not elsewhere classified
  '151254': '2513', // Web and multimedia developers
  '151255': '2513', // Web and multimedia developers
  '151299': '2529', // Database and network professionals not elsewhere classified
  '152011': '2120', // Mathematicians, actuaries and statisticians
  '152021': '2120', // Mathematicians, actuaries and statisticians
  '152031': '2120', // Mathematicians, actuaries and statisticians
  '152041': '2120', // Mathematicians, actuaries and statisticians
  '1520XX': '2120', // Mathematicians, actuaries and statisticians
  '171011': '2161', // Building architects
  '171012': '2162', // Landscape architects
  '171020': '2165', // Cartographers and surveyors
  '172011': '2144', // Mechanical engineers
  '172021': '2144', // Mechanical engineers
  '172031': '2149', // Engineering professionals not elsewhere classified
  '172041': '2145', // Chemical engineers
  '172051': '2142', // Civil engineers
  '172061': '2152', // Electronics engineers
  '172070': '2152', // Electronics engineers
  '172081': '2143', // Environmental engineers
  '172110': '2149', // Engineering professionals not elsewhere classified
  '172121': '2144', // Mechanical engineers
  '172131': '2149', // Engineering professionals not elsewhere classified
  '172141': '2144', // Mechanical engineers
  '172151': '2146', // Mining engineers, metallurgists and related professionals
  '172161': '2149', // Engineering professionals not elsewhere classified
  '172171': '2146', // Mining engineers, metallurgists and related professionals
  '172199': '2149', // Engineering professionals not elsewhere classified
  '173011': '3118', // Draughtspersons
  '173023': '3114', // Electronics engineering technicians
  '173031': '3112', // Civil engineering technicians
  '17301X': '3118', // Draughtspersons
  '17302X': '3115', // Mechanical engineering technicians
  '191010': '2131', // Biologists, botanists, zoologists and related professionals
  '191020': '2131', // Biologists, botanists, zoologists and related professionals
  '191030': '2133', // Environmental protection professionals
  '191040': '2131', // Biologists, botanists, zoologists and related professionals
  '191099': '2131', // Biologists, botanists, zoologists and related professionals
  '192010': '2111', // Physicists and astronomers
  '192021': '2112', // Meteorologists
  '192030': '2113', // Chemists
  '192041': '2133', // Environmental protection professionals
  '19204X': '2133', // Environmental protection professionals
  '192099': '2114', // Geologists and geophysicists
  '193011': '2631', // Economists
  '193022': '2120', // Mathematicians, actuaries and statisticians
  '193033': '2634', // Psychologists
  '193034': '2634', // Psychologists
  '193041': '2632', // Sociologists, anthropologists and related professionals
  '193051': '2164', // Town and traffic planners
  '193090': '2632', // Sociologists, anthropologists and related professionals
  '19303X': '2634', // Psychologists
  '194010': '3142', // Agricultural technicians
  '194021': '3141', // Life science technicians (excluding medical)
  '194031': '3111', // Chemical and physical science technicians
  '194040': '3111', // Chemical and physical science technicians
  '194051': '3111', // Chemical and physical science technicians
  '194061': '3314', // Statistical, mathematical and related associate professionals
  '195010': '2263', // Environmental and occupational health and hygiene professionals
  '1940XX': '3111', // Chemical and physical science technicians
  '211011': '2635', // Social work and counselling professionals
  '211012': '2359', // Teaching professionals not elsewhere classified
  '211013': '2635', // Social work and counselling professionals
  '211014': '2635', // Social work and counselling professionals
  '211015': '2635', // Social work and counselling professionals
  '211019': '2635', // Social work and counselling professionals
  '211021': '2635', // Social work and counselling professionals
  '211022': '2635', // Social work and counselling professionals
  '211023': '2635', // Social work and counselling professionals
  '211029': '2635', // Social work and counselling professionals
  '211092': '2635', // Social work and counselling professionals
  '211093': '3412', // Social work associate professionals
  '21109X': '2635', // Social work and counselling professionals
  '212011': '2636', // Religious professionals
  '212021': '2636', // Religious professionals
  '212099': '3413', // Religious associate professionals
  '251000': '2310', // University and higher education teachers
  '252010': '2342', // Early childhood educators
  '252020': '2341', // Primary school teachers
  '252030': '2330', // Secondary education teachers
  '252050': '2352', // Special needs teachers
  '253041': '2359', // Teaching professionals not elsewhere classified
  '254010': '2621', // Archivists and curators
  '254022': '2622', // Librarians and related information professionals
  '254031': '3433', // Gallery, museum and library technicians
  '259040': '5312', // Teachers’ aides
  '2530XX': '2359', // Teaching professionals not elsewhere classified
  '2590XX': '5312', // Teachers’ aides
  '231011': '2611', // Lawyers
  '231012': '3411', // Legal and related associate professionals
  '231020': '2612', // Judges
  '232011': '3411', // Legal and related associate professionals
  '232093': '3411', // Legal and related associate professionals
  '232099': '3411', // Legal and related associate professionals
  '271010': '2166', // Graphic and multimedia designers
  '271021': '2163', // Product and garment designers
  '271022': '2163', // Product and garment designers
  '271023': '7549', // Craft and related workers not elsewhere classified
  '271024': '2166', // Graphic and multimedia designers
  '271025': '3432', // Interior designers and decorators
  '271026': '3432', // Interior designers and decorators
  '27102X': '2163', // Product and garment designers
  '272011': '2655', // Actors
  '272012': '2654', // Film, stage and related directors and producers
  '272021': '3421', // Athletes and sports players
  '272022': '3422', // Sports coaches, instructors and officials
  '272023': '3422', // Sports coaches, instructors and officials
  '272030': '2653', // Dancers and choreographers
  '272041': '2652', // Musicians, singers and composers
  '272042': '2652', // Musicians, singers and composers
  '272091': '2659', // Creative and performing artists not elsewhere classified
  '272099': '3435', // Other artistic and cultural associate professionals
  '273011': '2656', // Announcers on radio, television and other media
  '273023': '2642', // Journalists
  '273031': '2432', // Public relations professionals
  '273041': '2642', // Journalists
  '273042': '2641', // Authors and related writers
  '273043': '2641', // Authors and related writers
  '273091': '2643', // Translators, interpreters and other linguists
  '273092': '3343', // Administrative and executive secretaries
  '273099': '2656', // Announcers on radio, television and other media
  '274010': '3521', // Broadcasting and audiovisual technicians
  '274021': '3431', // Photographers
  '274030': '2654', // Film, stage and related directors and producers
  '274099': '3435', // Other artistic and cultural associate professionals
  '291011': '2269', // Health professionals not elsewhere classified
  '291020': '2261', // Dentists
  '291031': '2265', // Dieticians and nutritionists
  '291041': '2267', // Optometrists and ophthalmic opticians
  '291051': '2262', // Pharmacists
  '291071': '2240', // Paramedical practitioners
  '291081': '2269', // Health professionals not elsewhere classified
  '291122': '2269', // Health professionals not elsewhere classified
  '291123': '2264', // Physiotherapists
  '291124': '3211', // Medical imaging and therapeutic equipment technicians
  '291125': '2269', // Health professionals not elsewhere classified
  '291126': '3259', // Health associate professionals not elsewhere classified
  '291127': '2266', // Audiologists and speech therapists
  '291128': '2264', // Physiotherapists
  '291129': '2269', // Health professionals not elsewhere classified
  '291131': '2250', // Veterinarians
  '291141': '2221', // Nursing professionals
  '291151': '2221', // Nursing professionals
  '291161': '2222', // Midwifery professionals
  '291171': '2221', // Nursing professionals
  '291181': '2266', // Audiologists and speech therapists
  '291214': '2212', // Specialist medical practitioners
  '291224': '2212', // Specialist medical practitioners
  '291240': '2212', // Specialist medical practitioners
  '291291': '2230', // Traditional and complementary medicine professionals
  '291292': '3251', // Dental assistants and therapists
  '291299': '2230', // Traditional and complementary medicine professionals
  '2912XX': '2212', // Specialist medical practitioners
  '292010': '3212', // Medical and pathology laboratory technicians
  '292031': '3259', // Health associate professionals not elsewhere classified
  '292032': '3211', // Medical imaging and therapeutic equipment technicians
  '292034': '3211', // Medical imaging and therapeutic equipment technicians
  '292035': '3211', // Medical imaging and therapeutic equipment technicians
  '292042': '3258', // Ambulance workers
  '292043': '3258', // Ambulance workers
  '292052': '3213', // Pharmaceutical technicians and assistants
  '292053': '3259', // Health associate professionals not elsewhere classified
  '292055': '3259', // Health associate professionals not elsewhere classified
  '292056': '3240', // Veterinary technicians and assistants
  '292061': '3221', // Nursing associate professionals
  '292072': '3252', // Medical records and health information technicians
  '292081': '3254', // Dispensing opticians
  '292090': '3214', // Medical and dental prosthetic technicians
  '29203X': '3211', // Medical imaging and therapeutic equipment technicians
  '29205X': '3259', // Health associate professionals not elsewhere classified
  '299000': '2269', // Health professionals not elsewhere classified
  '311121': '5322', // Home-based personal care workers
  '311131': '5321', // Health care assistants
  '31113X': '5321', // Health care assistants
  '312010': '3259', // Health associate professionals not elsewhere classified
  '312020': '3255', // Physiotherapy technicians and assistants
  '319011': '3255', // Physiotherapy technicians and assistants
  '319091': '3251', // Dental assistants and therapists
  '319092': '3256', // Medical assistants
  '319094': '3344', // Medical secretaries
  '319095': '3213', // Pharmaceutical technicians and assistants
  '319096': '5164', // Pet groomers and animal care workers
  '319097': '5329', // Personal care workers in health services not elsewhere classified
  '31909X': '3259', // Health associate professionals not elsewhere classified
  '331011': '5413', // Prison guards
  '331012': '3355', // Police inspectors and detectives
  '331021': '5411', // Fire-fighters
  '331091': '5414', // Security guards
  '331099': '5419', // Protective services workers not elsewhere classified
  '332011': '5411', // Fire-fighters
  '332020': '3112', // Civil engineering technicians
  '333011': '3411', // Legal and related associate professionals
  '333012': '5413', // Prison guards
  '333021': '3355', // Police inspectors and detectives
  '333031': '5419', // Protective services workers not elsewhere classified
  '333041': '5419', // Protective services workers not elsewhere classified
  '333050': '3355', // Police inspectors and detectives
  '339011': '5419', // Protective services workers not elsewhere classified
  '339021': '3411', // Legal and related associate professionals
  '339030': '5414', // Security guards
  '339091': '5419', // Protective services workers not elsewhere classified
  '339093': '5414', // Security guards
  '339094': '5419', // Protective services workers not elsewhere classified
  '33909X': '5414', // Security guards
  '351011': '3434', // Chefs
  '351012': '3434', // Chefs
  '352010': '5120', // Cooks
  '352021': '9412', // Kitchen helpers
  '353011': '5132', // Bartenders
  '353023': '5246', // Food service counter attendants
  '353031': '5131', // Waiters
  '353041': '5131', // Waiters
  '359011': '5246', // Food service counter attendants
  '359021': '9412', // Kitchen helpers
  '359031': '5169', // Personal services workers not elsewhere classified
  '359099': '9412', // Kitchen helpers
  '371011': '5151', // Cleaning and housekeeping supervisors in offices, hotels and other establishments
  '371012': '6113', // Gardeners, horticultural and nursery growers
  '37201X': '9112', // Cleaners and helpers in offices, hotels and other establishments
  '372012': '9111', // Domestic cleaners and helpers
  '372021': '7544', // Fumigators and other pest and weed controllers
  '373011': '9214', // Garden and horticultural labourers
  '373013': '6113', // Gardeners, horticultural and nursery growers
  '37301X': '6113', // Gardeners, horticultural and nursery growers
  '391000': '4212', // Bookmakers, croupiers and related gaming workers
  '392011': '5164', // Pet groomers and animal care workers
  '392021': '5164', // Pet groomers and animal care workers
  '393010': '4212', // Bookmakers, croupiers and related gaming workers
  '393031': '9629', // Elementary workers not elsewhere classified
  '394031': '5163', // Undertakers and embalmers
  '395011': '5141', // Hairdressers
  '395012': '5142', // Beauticians and related workers
  '395092': '5142', // Beauticians and related workers
  '395094': '5142', // Beauticians and related workers
  '396010': '9621', // Messengers, package deliverers and luggage porters
  '397010': '5113', // Travel guides
  '399011': '5311', // Child care workers
  '399031': '3423', // Fitness and recreation instructors and program leaders
  '399032': '3423', // Fitness and recreation instructors and program leaders
  '399041': '3412', // Social work associate professionals
  '399099': '5169', // Personal services workers not elsewhere classified
  '3930XX': '4212', // Bookmakers, croupiers and related gaming workers
  '3940XX': '5163', // Undertakers and embalmers
  '39509X': '5142', // Beauticians and related workers
  '411011': '5222', // Shop supervisors
  '411012': '3322', // Commercial sales representatives
  '412010': '5230', // Cashiers and ticket clerks
  '412021': '5249', // Sales workers not elsewhere classified
  '412022': '5223', // Shop sales assistants
  '412031': '5223', // Shop sales assistants
  '413011': '3339', // Business services agents not elsewhere classified
  '413021': '3321', // Insurance representatives
  '413031': '3311', // Securities and finance dealers and brokers
  '413041': '4221', // Travel consultants and clerks
  '413091': '3322', // Commercial sales representatives
  '414010': '3322', // Commercial sales representatives
  '419010': '5241', // Fashion and other models
  '419020': '3334', // Real estate agents and property managers
  '419031': '2434', // Information and communications technology sales professionals
  '419041': '5244', // Contact centre salespersons
  '419091': '9520', // Street vendors (excluding food)
  '419099': '5249', // Sales workers not elsewhere classified
  '432011': '4223', // Telephone switchboard operators
  '432021': '4223', // Telephone switchboard operators
  '432099': '4229', // Client information workers not elsewhere classified
  '433011': '4214', // Debt-collectors and related workers
  '433021': '4311', // Accounting and bookkeeping clerks
  '433031': '4311', // Accounting and bookkeeping clerks
  '433041': '4212', // Bookmakers, croupiers and related gaming workers
  '433051': '4313', // Payroll clerks
  '433061': '4110', // General office clerks
  '433071': '4211', // Bank tellers and related clerks
  '433099': '4312', // Statistical, finance and insurance clerks
  '434011': '4312', // Statistical, finance and insurance clerks
  '434021': '4419', // Clerical support workers not elsewhere classified
  '434031': '3354', // Government licensing officials
  '434041': '4312', // Statistical, finance and insurance clerks
  '434051': '4222', // Contact centre information clerks
  '434061': '3353', // Government social benefits officials
  '434071': '4415', // Filing and copying clerks
  '434081': '4224', // Hotel receptionists
  '434111': '4227', // Survey and market research interviewers
  '434121': '4411', // Library clerks
  '434131': '4312', // Statistical, finance and insurance clerks
  '434141': '4312', // Statistical, finance and insurance clerks
  '434151': '4419', // Clerical support workers not elsewhere classified
  '434161': '4416', // Personnel clerks
  '434171': '4226', // Receptionists (general)
  '434181': '4221', // Travel consultants and clerks
  '434199': '4229', // Client information workers not elsewhere classified
  '435011': '3331', // Clearing and forwarding agents
  '435021': '4412', // Mail carriers and sorting clerks
  '435031': '5419', // Protective services workers not elsewhere classified
  '435032': '4323', // Transport clerks
  '435041': '9623', // Meter readers and vending-machine collectors
  '435051': '4211', // Bank tellers and related clerks
  '435052': '4412', // Mail carriers and sorting clerks
  '435053': '4412', // Mail carriers and sorting clerks
  '435061': '4322', // Production clerks
  '435071': '4321', // Stock clerks
  '435111': '4321', // Stock clerks
  '436011': '3343', // Administrative and executive secretaries
  '436012': '3342', // Legal secretaries
  '436013': '3344', // Medical secretaries
  '436014': '4120', // Secretaries (general)
  '439021': '4132', // Data entry clerks
  '439022': '4131', // Typists and word processing operators
  '439031': '7321', // Pre-press technicians
  '439041': '4312', // Statistical, finance and insurance clerks
  '439051': '4412', // Mail carriers and sorting clerks
  '439061': '4110', // General office clerks
  '439071': '4415', // Filing and copying clerks
  '439081': '4413', // Coding, proof-reading and related clerks
  '439111': '3314', // Statistical, mathematical and related associate professionals
  '439199': '4419', // Clerical support workers not elsewhere classified
  '451011': '6130', // Mixed crop and animal producers
  '452011': '3359', // Regulatory government associate professionals not elsewhere classified
  '452021': '6121', // Livestock and dairy producers
  '452041': '7515', // Food and beverage tasters and graders
  '452090': '9213', // Mixed crop and livestock farm labourers
  '453031': '6222', // Inland and coastal waters fishery workers
  '454011': '9215', // Forestry labourers
  '454020': '6210', // Forestry and related workers
  '471011': '3123', // Construction supervisors
  '472011': '7213', // Sheet-metal workers
  '472020': '7112', // Bricklayers and related workers
  '472031': '7115', // Carpenters and joiners
  '472040': '7122', // Floor layers and tile setters
  '472050': '7114', // Concrete placers, concrete finishers and related workers
  '472061': '9313', // Building construction labourers
  '472070': '8342', // Earthmoving and related plant operators
  '472080': '7123', // Plasterers
  '472111': '7411', // Building and related electricians
  '472121': '7125', // Glaziers
  '472130': '7124', // Insulation workers
  '472140': '7131', // Painters and related workers
  '472151': '7126', // Plumbers and pipe fitters
  '472152': '7126', // Plumbers and pipe fitters
  '472161': '7123', // Plasterers
  '472171': '7214', // Structural-metal preparers and erectors
  '472181': '7121', // Roofers
  '472211': '7213', // Sheet-metal workers
  '472221': '7214', // Structural-metal preparers and erectors
  '472231': '7411', // Building and related electricians
  '473010': '9313', // Building construction labourers
  '474011': '3112', // Civil engineering technicians
  '474021': '7412', // Electrical mechanics and fitters
  '474031': '7119', // Building frame and related trades workers not elsewhere classified
  '474041': '7119', // Building frame and related trades workers not elsewhere classified
  '474051': '9312', // Civil engineering labourers
  '474061': '9312', // Civil engineering labourers
  '474071': '9129', // Other cleaning workers
  '474090': '7119', // Building frame and related trades workers not elsewhere classified
  '475010': '8113', // Well drillers and borers and related workers
  '475022': '8342', // Earthmoving and related plant operators
  '475023': '8113', // Well drillers and borers and related workers
  '475032': '7542', // Shotfirers and blasters
  '475040': '8111', // Miners and quarriers
  '475071': '8113', // Well drillers and borers and related workers
  '4750XX': '8113', // Well drillers and borers and related workers
  '491011': '7233', // Agricultural and industrial machinery mechanics and repairers
  '492011': '7422', // Information and communications technology installers and servicers
  '492020': '7422', // Information and communications technology installers and servicers
  '492091': '7421', // Electronics mechanics and servicers
  '492092': '7412', // Electrical mechanics and fitters
  '492093': '7421', // Electronics mechanics and servicers
  '492096': '7421', // Electronics mechanics and servicers
  '492097': '7422', // Information and communications technology installers and servicers
  '492098': '7412', // Electrical mechanics and fitters
  '49209X': '7421', // Electronics mechanics and servicers
  '493011': '7232', // Aircraft engine mechanics and repairers
  '493021': '7231', // Motor vehicle mechanics and repairers
  '493022': '7231', // Motor vehicle mechanics and repairers
  '493023': '7231', // Motor vehicle mechanics and repairers
  '493031': '7231', // Motor vehicle mechanics and repairers
  '493040': '7233', // Agricultural and industrial machinery mechanics and repairers
  '493050': '7231', // Motor vehicle mechanics and repairers
  '493090': '7231', // Motor vehicle mechanics and repairers
  '499010': '7412', // Electrical mechanics and fitters
  '499021': '7127', // Air conditioning and refrigeration mechanics
  '499031': '7412', // Electrical mechanics and fitters
  '499043': '7233', // Agricultural and industrial machinery mechanics and repairers
  '499044': '7233', // Agricultural and industrial machinery mechanics and repairers
  '499051': '7413', // Electrical line installers and repairers
  '499052': '7422', // Information and communications technology installers and servicers
  '499060': '7312', // Musical instrument makers and tuners
  '499071': '9622', // Odd job persons
  '499081': '7412', // Electrical mechanics and fitters
  '499091': '9623', // Meter readers and vending-machine collectors
  '499092': '7541', // Underwater divers
  '499094': '7222', // Toolmakers and related workers
  '499095': '7119', // Building frame and related trades workers not elsewhere classified
  '499096': '7215', // Riggers and cable splicers
  '499098': '9329', // Manufacturing labourers not elsewhere classified
  '49904X': '7233', // Agricultural and industrial machinery mechanics and repairers
  '49909X': '7215', // Riggers and cable splicers
  '511011': '3122', // Manufacturing supervisors
  '512011': '8211', // Mechanical machinery assemblers
  '512020': '8212', // Electrical and electronic equipment assemblers
  '512031': '8211', // Mechanical machinery assemblers
  '512041': '7214', // Structural-metal preparers and erectors
  '5120XX': '8211', // Mechanical machinery assemblers
  '513011': '7512', // Bakers, pastry-cooks and confectionery makers
  '513020': '7511', // Butchers, fishmongers and related food preparers
  '513091': '8160', // Food and related products machine operators
  '513092': '8160', // Food and related products machine operators
  '513093': '8160', // Food and related products machine operators
  '513099': '8160', // Food and related products machine operators
  '514020': '7223', // Metal working machine tool setters and operators
  '514031': '7223', // Metal working machine tool setters and operators
  '514041': '7223', // Metal working machine tool setters and operators
  '514050': '8121', // Metal processing plant operators
  '514060': '7222', // Toolmakers and related workers
  '514070': '7211', // Metal moulders and coremakers
  '514111': '7222', // Toolmakers and related workers
  '514120': '7212', // Welders and flamecutters
  '51403X': '7223', // Metal working machine tool setters and operators
  '514XXX': '7223', // Metal working machine tool setters and operators
  '515111': '7321', // Pre-press technicians
  '515112': '7322', // Printers
  '515113': '7323', // Print finishing and binding workers
  '516011': '8157', // Laundry machine operators
  '516021': '9121', // Hand launderers and pressers
  '516031': '8153', // Sewing machine operators
  '516040': '7536', // Shoemakers and related workers
  '516050': '7533', // Sewing, embroidery and related workers
  '516060': '8152', // Weaving and knitting machine operators
  '516093': '7534', // Upholsterers and related workers
  '51609X': '7534', // Upholsterers and related workers
  '517011': '7522', // Cabinet-makers and related workers
  '517021': '7522', // Cabinet-makers and related workers
  '517041': '8172', // Wood processing plant operators
  '517042': '7523', // Woodworking-machine tool setters and operators
  '5170XX': '8172', // Wood processing plant operators
  '518010': '3131', // Power production plant operators
  '518021': '8182', // Steam engine and boiler operators
  '518031': '3132', // Incinerator and water treatment plant operators
  '518090': '3133', // Chemical processing plant controllers
  '519010': '8131', // Chemical products plant and machine operators
  '519020': '8112', // Mineral and stone processing plant operators
  '519030': '7532', // Garment and related pattern-makers and cutters
  '519041': '8142', // Plastic products machine operators
  '519051': '8181', // Glass and ceramics plant operators
  '519061': '7543', // Product graders and testers (excluding foods and beverages)
  '519071': '7313', // Jewellery and precious-metal workers
  '519080': '3214', // Medical and dental prosthetic technicians
  '519111': '8183', // Packing, bottling and labelling machine operators
  '519120': '7316', // Sign writers, decorative painters, engravers and etchers
  '519151': '8132', // Photographic products machine operators
  '519160': '7223', // Metal working machine tool setters and operators
  '519191': '8143', // Paper products machine operators
  '519194': '7316', // Sign writers, decorative painters, engravers and etchers
  '519195': '8181', // Glass and ceramics plant operators
  '519196': '8143', // Paper products machine operators
  '519197': '8141', // Rubber products machine operators
  '519198': '9329', // Manufacturing labourers not elsewhere classified
  '51919X': '8141', // Rubber products machine operators
  '5191XX': '7223', // Metal working machine tool setters and operators
  '531000': '1324', // Supply, distribution and related managers
  '532010': '3153', // Aircraft pilots and related associate professionals
  '532020': '3154', // Air traffic controllers
  '532031': '5111', // Travel attendants and travel stewards
  '533011': '8322', // Car, taxi and van drivers
  '533030': '8332', // Heavy truck and lorry drivers
  '533051': '8331', // Bus and tram drivers
  '533052': '8331', // Bus and tram drivers
  '533053': '8322', // Car, taxi and van drivers
  '533054': '8322', // Car, taxi and van drivers
  '533099': '8321', // Motorcycle drivers
  '534010': '8311', // Locomotive engine drivers
  '534031': '8312', // Railway brake, signal and switch operators
  '535011': '8350', // Ships’ deck crews and related workers
  '535020': '3152', // Ships' deck officers and pilots
  '535031': '3151', // Ships’ engineers
  '536021': '9629', // Elementary workers not elsewhere classified
  '536030': '5245', // Service station attendants
  '536051': '3359', // Regulatory government associate professionals not elsewhere classified
  '536061': '5111', // Travel attendants and travel stewards
  '5340XX': '8312', // Railway brake, signal and switch operators
  '5360XX': '9629', // Elementary workers not elsewhere classified
  '537021': '8343', // Crane, hoist and related plant operators
  '537051': '8344', // Lifting truck operators
  '537061': '9112', // Cleaners and helpers in offices, hotels and other establishments
  '537062': '9333', // Freight handlers
  '537063': '9329', // Manufacturing labourers not elsewhere classified
  '537064': '9321', // Hand packers
  '537065': '4321', // Stock clerks
  '537070': '8113', // Well drillers and borers and related workers
  '537081': '9611', // Garbage and recycling collectors
  '5370XX': '9333', // Freight handlers
  '5371XX': '9333', // Freight handlers
  '551010': '0110', // Commissioned armed forces officers
  '552010': '0210', // Non-commissioned armed forces officers
  '553010': '0310', // Armed forces occupations, other ranks
  '554010': '0310', // Armed forces occupations, other ranks
};
