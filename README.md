# João

**Un solo escritorio para GNOME Shell.**
Creado y diseñado por **Frank Molina**.

João reúne en una sola extensión las escenas de ventanas y un lanzador a pantalla completa que sustituye a la barra superior de GNOME.

## Funciones

- **Escenas de ventanas**: la escena activa en el centro y las demás en una franja lateral, con su vista previa. Una app minimizada se cierra desde su miniatura.
- **Lanzador a pantalla completa**: se abre con la tecla Super, con Super + Mayús + Espacio o con la burbuja de la franja. Reúne escenas guardadas, apps, búsqueda y un panel del sistema.
- **Escenas guardadas**: guarda tus ventanas tal como están o arma una escena arrastrando apps, y ábrela de una vez.
- **Distribución automática**: las escenas nuevas reparten sus ventanas solas según cuántas haya (mitades, 2×2, 3×2).
- **Organizar ventanas**: arrastra una ventana a un borde o una esquina para colocarla en mitades o cuartos, con vista previa, o usa Super + flechas.
- **Panel del sistema**: ajustes rápidos, volumen, brillo, perfil de energía, Modo activo, calendario, notificaciones y energía.
- **Calendario con tareas**: semana o mes con puntos por día (eventos, tareas y tareas atrasadas), la lista del día elegido, tareas con hora («Llamar a las 9») y las atrasadas arriba en rojo. Los eventos salen del calendario de GNOME.
- **Notificaciones agrupadas por app**: una tarjeta apilada por app que se abre con un clic, y encima la nota fijada.
- **Herramientas del anillo**: clic derecho en el botón del lanzador y la tarjeta de escenas se convierte en un menú con **nota rápida** (con «Mis notas» y listas con casillas), **portapapeles** (las últimas 25 copias, con filtros y búsqueda; no guarda lo que los gestores de contraseñas marcan como secreto) y **temporizador** (el tiempo se ve en el anillo y, al terminar, el botón vibra y avisa). Atajos: Super + Alt + N, Super + Alt + V y Super + T.
- **Notificaciones en la burbuja**: la burbuja salta, muestra el icono de la app y una línea de texto, y lleva el contador de no leídas. Al pasar el ratón sale la lista de las últimas. Si la franja está oculta, la burbuja aparece sola para avisar: nada sale arriba.
- **Volumen con la rueda**: la rueda del ratón sobre la franja o la burbuja cambia el volumen, y el control aparece un momento dentro de «Nueva escena».
- **Micrófono, cámara y pantalla**: el anillo del botón se reparte en gajos de color mientras se usan; al pasar el ratón, la tarjeta «En uso ahora» dice qué app los usa, desde cuándo, y deja detenerlos.

## Requisitos

GNOME Shell 48, 49, 50 o 51.

## Instalación

Con el paquete `.zip` (descárgalo de [Releases](https://github.com/FrankM03-code/Joao/releases/latest)):

```sh
gnome-extensions install --force Joao-4.6.shell-extension.zip
```

Desde este repositorio:

```sh
./install.sh
```

Después cierra la sesión y vuelve a entrar (en X11 basta con Alt + F2 y `r`), y actívala:

```sh
gnome-extensions enable joao@frankm
```

## Antes de activarla

João cambia cómo funciona el escritorio: oculta la barra superior, usa la tecla Super para su lanzador y toma algunos atajos de GNOME, que devuelve al apagarla. La barra, los atajos y las notificaciones se ajustan en sus preferencias.

Si en Firefox solo una página de chat tiene permiso de notificar, puedes activar en Preferencias → Isla de notificaciones la opción de mostrar esos avisos con el nombre de ese chat. Firefox no dice de qué página viene cada aviso, así que todos saldrán con ese nombre.

## Licencia

GPL-2.0-or-later. Ver [LICENSE](LICENSE).
