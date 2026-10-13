# Ръчно обновяване на данните за картата

От основната директория на проекта `GTSOFIA Live` стартирай:

```bash
python scripts/update-map-data.py
```

Скриптът изтегля последно публикувания `data/transport.json` от основния проект GTSofia, преобразува го в компактния формат за картата и обновява само `data/transport-map.json`.

Ако си генерирал нов `data/transport.json` локално в основния проект и не искаш първо да го публикуваш в GitHub, подай пътя към локалния файл:

```bash
python scripts/update-map-data.py --source ../gtsofia-main/data/transport.json
```

По подразбиране не се добавя автоматичен график и не се променят `route-catalog.json`, `stop-catalog.json`, `depot-rules.json` или `expected-models.json`. Скриптът проверява дали новият резултат изглежда пълен и запазва стария файл при грешка. Също така отказва да замени по-нови данни с по-стар източник.

След успешно обновяване провери промените с `git diff -- data/transport-map.json`, тествай картата и комитни променения файл.
